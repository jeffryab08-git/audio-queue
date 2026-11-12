/**
 * Web fallback engine.
 *
 * What it does well:
 *  - Hands metadata + transport controls to the OS through the Media Session API,
 *    so Chromium/Edge/Safari show a real media notification and lock-screen card.
 *  - Double buffers the next track: a second <audio> element is preloaded (and
 *    usually already decrypted/parsed) before the current one ends, so the swap
 *    is a `play()` on an element that is already `readyState >= HAVE_FUTURE_DATA`.
 *  - Recovers from network errors with bounded retries without touching the
 *    current track.
 *
 * What it cannot do (documented in docs/LIMITATIONS.md):
 *  - Keep running when the browser process is frozen. On Android Chrome, a page
 *    that is playing audio keeps an audio focus + media notification and is
 *    normally *not* frozen, but the OS may still throttle its network; on iOS
 *    Safari a locked device can suspend the page entirely. There is no web API
 *    that grants "keep my JS running while the screen is off" — that is exactly
 *    why the native engines exist. Use this engine for desktop/PWA, not as the
 *    mobile answer.
 */

import type {
  MediaQueueApi,
  MediaQueueEventMap,
  MediaQueueEventName,
  PlaybackState,
  QueueErrorEvent,
  RepeatMode,
  SetQueueOptions,
  Track,
  Unsubscribe,
} from './definitions.js';
import { QueueCore } from './queue-core.js';

export interface AudioLike {
  src: string;
  preload: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  /** True once the element reached the end of the media. */
  readonly ended: boolean;
  volume: number;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: (ev?: unknown) => void): void;
  removeEventListener(type: string, listener: (ev?: unknown) => void): void;
}

export interface WebEngineOptions {
  /** Injectable for tests. Defaults to `() => new Audio()`. */
  audioFactory?: () => AudioLike;
  /** Injectable for tests. Defaults to `navigator.mediaSession`. */
  mediaSession?: MediaSession | null;
  /** Injectable for tests. Defaults to `navigator`. */
  nav?: Navigator | null;
  /** Retries per track before reporting a fatal error. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms (doubles each attempt). Default 800. */
  retryBaseMs?: number;
  /** progress event interval in ms. Default 500. */
  progressIntervalMs?: number;
  /**
   * Injectable `MediaMetadata` factory (tests, SSR). Defaults to the global
   * `MediaMetadata` constructor; when neither exists metadata is skipped.
   */
  metadataFactory?: (init: MetadataInit) => unknown;
}

export interface MetadataInit {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string }[];
}

type Emitter = {
  [E in MediaQueueEventName]: Set<(payload: MediaQueueEventMap[E]) => void>;
};

const SLOT_FORWARD = 0;
const SLOT_BACK = 1;

export class WebMediaQueue implements MediaQueueApi {
  private readonly core = new QueueCore();
  private readonly options: Required<Pick<WebEngineOptions, 'maxRetries' | 'retryBaseMs' | 'progressIntervalMs'>> &
    WebEngineOptions;
  private readonly listeners: Emitter = {
    trackChanged: new Set(),
    stateChanged: new Set(),
    queueChanged: new Set(),
    error: new Set(),
    progress: new Set(),
  };

  /** Two elements, alternating. `activeSlot` is the one currently audible. */
  private elements: AudioLike[] = [];
  private activeSlot = SLOT_FORWARD;
  private preloadedSlot: number | null = null;
  private preloadedIndex: number | null = null;
  private retries = 0;
  private volume = 1;
  private rate = 1;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private playing = false;
  private buffering = false;
  private disposed = false;
  /** Set while we swap elements, so the old element's `pause` is not reported as a user pause. */
  private swapping = false;

  constructor(options: WebEngineOptions = {}) {
    this.options = { maxRetries: 3, retryBaseMs: 800, progressIntervalMs: 500, ...options };
  }

  // ---------------------------------------------------------------- elements

  private get active(): AudioLike {
    return this.elements[this.activeSlot]!;
  }

  private get inactive(): AudioLike {
    return this.elements[this.activeSlot === SLOT_FORWARD ? SLOT_BACK : SLOT_FORWARD];
  }

  private ensureElements(): void {
    if (this.elements.length === 2) return;
    const factory =
      this.options.audioFactory ??
      (() => new Audio() as unknown as AudioLike);
    this.elements = [factory(), factory()];
    for (const el of this.elements) {
      el.preload = 'auto';
      el.volume = this.volume;
      el.playbackRate = this.rate;
    }
    this.wire(this.elements[SLOT_FORWARD]!, SLOT_FORWARD);
    this.wire(this.elements[SLOT_BACK]!, SLOT_BACK);
  }

  private wire(el: AudioLike, slot: number): void {
    el.addEventListener('ended', () => {
      if (slot !== this.activeSlot) return;
      void this.handleEnded();
    });
    el.addEventListener('error', () => {
      if (slot !== this.activeSlot) return;
      this.handleError('NETWORK', 'Audio element failed to load the current track');
    });
    el.addEventListener('waiting', () => {
      if (slot !== this.activeSlot) return;
      this.buffering = true;
      this.emitState();
    });
    el.addEventListener('playing', () => {
      if (slot !== this.activeSlot) return;
      this.buffering = false;
      this.playing = true;
      this.emitState();
      this.startProgress();
    });
    el.addEventListener('pause', () => {
      if (slot !== this.activeSlot || this.swapping) return;
      // Chrome and Safari fire `pause` right before `ended` when a track finishes
      // on its own. Treating that as a user pause flipped `playing` to false and
      // the auto-advance then refused to start the next track (found in a real
      // browser, invisible to the fake-element tests until they mimicked it).
      if (el.ended) return;
      this.playing = false;
      this.emitState();
    });
  }

  // ------------------------------------------------------------------ queue

  async setQueue(tracks: Track[], options: SetQueueOptions = {}): Promise<void> {
    this.ensureElements();
    const startIndex = this.core.setQueue(tracks, options.startIndex ?? 0);
    this.retries = 0;
    if (startIndex < 0) {
      this.active.pause();
      this.playing = false;
      this.emitState();
      this.emitQueue();
      return;
    }
    await this.loadInto(this.active, tracks[startIndex]!);
    if (options.startPosition && options.startPosition > 0) {
      this.active.currentTime = options.startPosition;
    }
    if (options.autoplay !== false) await this.startPlayback();
    this.emitQueue();
    this.emitTrackChanged('queue');
    this.preloadNext();
  }

  async addToQueue(track: Track): Promise<void> {
    this.core.append(track);
    this.emitQueue();
    if (this.core.length === 1) {
      await this.setQueue([track], { autoplay: false });
    } else {
      this.preloadNext();
    }
  }

  async insertAfterCurrent(track: Track): Promise<void> {
    await this.insertAt(track, this.core.currentIndex + 1);
  }

  async insertAt(track: Track, index: number): Promise<void> {
    this.core.insertAt(track, index);
    this.emitQueue();
    this.preloadNext();
  }

  async removeAt(index: number): Promise<void> {
    const wasCurrent = index === this.core.currentIndex;
    this.core.removeAt(index);
    this.emitQueue();
    if (this.core.length === 0) {
      await this.stop();
      return;
    }
    if (wasCurrent) {
      await this.loadInto(this.active, this.core.current!);
      if (this.playing) await this.startPlayback();
      this.preloadNext();
    } else {
      this.preloadNext();
    }
  }

  async move(from: number, to: number): Promise<void> {
    this.core.move(from, to);
    this.emitQueue();
  }

  // --------------------------------------------------------------- transport

  async play(): Promise<void> {
    this.ensureElements();
    await this.startPlayback();
  }

  async pause(): Promise<void> {
    this.playing = false;
    this.stopProgress();
    this.active.pause();
    this.updateMediaSessionState();
    this.emitState();
  }

  async next(): Promise<PlaybackState> {
    const nextIndex = this.core.advanceManual();
    if (nextIndex === null) {
      await this.pause();
      return this.state();
    }
    await this.transitionTo(nextIndex, 'next');
    return this.state();
  }

  async prev(): Promise<PlaybackState> {
    const prevIndex = this.core.previous();
    if (prevIndex === null) {
      this.active.currentTime = 0;
      return this.state();
    }
    await this.transitionTo(prevIndex, 'prev');
    return this.state();
  }

  async seekTo(seconds: number): Promise<void> {
    this.active.currentTime = Math.max(0, seconds);
    this.emitState();
  }

  async setRepeatMode(mode: RepeatMode): Promise<void> {
    this.core.setRepeatMode(mode);
    this.emitState();
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = Math.min(1, Math.max(0, volume));
    for (const el of this.elements) el.volume = this.volume;
    this.emitState();
  }

  async setPlaybackRate(rate: number): Promise<void> {
    this.rate = Math.max(0.25, Math.min(4, rate));
    for (const el of this.elements) el.playbackRate = this.rate;
  }

  async getState(): Promise<PlaybackState> {
    return this.state();
  }

  async getQueue(): Promise<{ tracks: Track[]; currentIndex: number }> {
    return { tracks: this.core.snapshot(), currentIndex: this.core.currentIndex };
  }

  async stop(): Promise<void> {
    this.swapping = true;
    try {
      for (const el of this.elements) {
        el.pause();
        el.currentTime = 0;
      }
    } finally {
      this.swapping = false;
    }
    this.playing = false;
    this.buffering = false;
    this.stopProgress();
    this.updateMediaSessionState();
    this.emitState();
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return { granted: true };
  }

  async addListener<E extends MediaQueueEventName>(
    event: E,
    listener: (payload: MediaQueueEventMap[E]) => void,
  ): Promise<Unsubscribe> {
    this.listeners[event].add(listener as never);
    return () => this.listeners[event].delete(listener as never);
  }

  async removeAllListeners(): Promise<void> {
    for (const key of Object.keys(this.listeners) as MediaQueueEventName[]) {
      this.listeners[key].clear();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopProgress();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const el of this.elements) {
      el.pause();
      el.removeEventListener('ended', () => {});
    }
    this.listeners.trackChanged.clear();
    this.listeners.stateChanged.clear();
    this.listeners.queueChanged.clear();
    this.listeners.error.clear();
    this.listeners.progress.clear();
    this.elements = [];
  }

  // ---------------------------------------------------------------- internals

  private async loadInto(el: AudioLike, track: Track): Promise<void> {
    el.src = track.url;
    el.currentTime = 0;
    el.load();
    this.setMediaSessionMetadata(track);
  }

  private async startPlayback(): Promise<void> {
    if (this.disposed) return;
    this.ensureElements();
    this.playing = true;
    try {
      await this.active.play();
      this.buffering = false;
      this.updateMediaSessionState();
      this.startProgress();
      this.emitState();
    } catch (err) {
      this.playing = false;
      this.emitState();
      const message = err instanceof Error ? err.message : String(err);
      this.emitError({
        code: 'PERMISSION',
        message: `play() rejected (autoplay policy or unsupported source): ${message}`,
        retries: 0,
        fatal: false,
      });
    }
  }

  /** Called by the element's own `ended` event — the only clock we trust. */
  private async handleEnded(): Promise<void> {
    const result = this.core.advanceAutomatic();
    if (result.kind === 'finished') {
      this.playing = false;
      this.stopProgress();
      this.updateMediaSessionState();
      this.emitState();
      return;
    }
    if (result.kind === 'same') {
      this.active.currentTime = 0;
      await this.startPlayback();
      return;
    }
    await this.transitionTo(result.index, 'ended');
  }

  /**
   * Swap to an already-preloaded element when possible: no network round trip,
   * no gap. Falls back to loading the track in place.
   */
  private async transitionTo(index: number, reason: 'ended' | 'next' | 'prev' | 'queue'): Promise<void> {
    this.ensureElements();
    const track = this.core.snapshot()[index];
    if (!track) return;

    const canSwap = this.preloadedIndex === index && this.preloadedSlot !== null;
    this.swapping = true;
    const old = this.active;
    let target: AudioLike;
    if (canSwap) {
      this.activeSlot = this.preloadedSlot!;
      target = this.active;
      this.preloadedSlot = null;
      this.preloadedIndex = null;
      // The retired element is not de-registered: every listener early-returns
      // once its slot is no longer active, so its `pause`/`ended` are inert.
      old.pause();
      target.currentTime = 0;
    } else {
      target = old;
      await this.loadInto(target, track);
    }
    this.swapping = false;
    this.core.setIndex(index);
    this.setMediaSessionMetadata(track);
    this.retries = 0;
    if (this.playing) await this.startPlayback();
    else this.emitState();
    this.emitTrackChanged(reason);
    this.preloadNext();
  }

  private preloadNext(): void {
    const next = this.core.advanceAutomatic();
    const nextIndex = next.kind === 'next' ? next.index : next.kind === 'same' ? this.core.currentIndex : -1;
    if (nextIndex < 0 || nextIndex === this.core.currentIndex) return;
    const track = this.core.snapshot()[nextIndex];
    if (!track || this.elements.length < 2) return;
    const el = this.activeSlot === SLOT_FORWARD ? this.elements[SLOT_BACK]! : this.elements[SLOT_FORWARD]!;
    el.src = track.url;
    el.load();
    this.preloadedSlot = this.activeSlot === SLOT_FORWARD ? SLOT_BACK : SLOT_FORWARD;
    this.preloadedIndex = nextIndex;
  }

  private handleError(code: QueueErrorEvent['code'], message: string): void {
    const track = this.core.current;
    if (this.retries < this.options.maxRetries && track) {
      const attempt = this.retries + 1;
      this.retries = attempt;
      const delay = this.options.retryBaseMs * Math.pow(2, attempt - 1);
      this.emitError({ code, message, trackId: track.id, retries: attempt, fatal: false });
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.disposed) return;
        void this.loadInto(this.active, track).then(() => {
          if (this.playing) return this.startPlayback();
          return undefined;
        });
      }, delay);
      return;
    }
    this.emitError({ code, message, trackId: track?.id, retries: this.retries, fatal: true });
    this.playing = false;
    this.emitState();
  }

  private state(): PlaybackState {
    const el = this.elements[this.activeSlot];
    return {
      isPlaying: this.playing,
      isBuffering: this.buffering,
      currentIndex: this.core.currentIndex,
      trackId: this.core.current?.id ?? null,
      position: el?.currentTime ?? 0,
      duration: Number.isFinite(el?.duration ?? 0) ? (el?.duration as number) : 0,
      repeatMode: this.core.repeatMode,
      queueLength: this.core.length,
      native: false,
    };
  }

  private startProgress(): void {
    if (this.progressTimer || this.disposed) return;
    this.progressTimer = setInterval(() => {
      if (!this.playing) return;
      const s = this.state();
      for (const l of this.listeners.progress) l({ position: s.position, duration: s.duration, trackId: s.trackId });
      this.updateMediaSessionPosition();
    }, this.options.progressIntervalMs);
  }

  private stopProgress(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private emitState(): void {
    const s = this.state();
    for (const l of this.listeners.stateChanged) l(s);
  }

  private emitQueue(): void {
    const payload = { tracks: this.core.snapshot(), currentIndex: this.core.currentIndex };
    for (const l of this.listeners.queueChanged) l(payload);
  }

  private emitTrackChanged(reason: 'ended' | 'next' | 'prev' | 'queue' | 'error'): void {
    const payload: MediaQueueEventMap['trackChanged'] = {
      index: this.core.currentIndex,
      track: this.core.current,
      automatic: reason === 'ended',
      reason,
      state: this.state(),
    };
    for (const l of this.listeners.trackChanged) l(payload);
  }

  private emitError(err: QueueErrorEvent): void {
    for (const l of this.listeners.error) l(err);
  }

  // ------------------------------------------------------------ media session

  private get session(): MediaSession | null {
    if (this.options.mediaSession !== undefined) return this.options.mediaSession;
    const nav = (this.options.nav ?? (typeof navigator !== 'undefined' ? navigator : null)) as
      | (Navigator & { mediaSession?: MediaSession })
      | null;
    return nav?.mediaSession ?? null;
  }

  private setMediaSessionMetadata(track: Track): void {
    const session = this.session;
    if (!session) return;
    const factory =
      this.options.metadataFactory ??
      (typeof MediaMetadata !== 'undefined' ? (init: MetadataInit) => new MediaMetadata(init) : null);
    if (!factory) return;
    session.metadata = factory({
      title: track.title ?? track.id,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512' }] : [],
    }) as MediaMetadata;
    this.registerActionHandlers();
    this.updateMediaSessionState();
  }

  private handlersRegistered = false;

  private registerActionHandlers(): void {
    const session = this.session;
    if (!session || this.handlersRegistered) return;
    this.handlersRegistered = true;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* unsupported action on this browser */
      }
    };
    set('play', () => void this.play());
    set('pause', () => void this.pause());
    set('stop', () => void this.stop());
    set('nexttrack', () => void this.next());
    set('previoustrack', () => void this.prev());
    set('seekbackward', (d) => void this.seekTo(this.active.currentTime - (d.seekOffset ?? 10)));
    set('seekforward', (d) => void this.seekTo(this.active.currentTime + (d.seekOffset ?? 10)));
    set('seekto', (d) => {
      if (typeof d.seekTime === 'number') void this.seekTo(d.seekTime);
    });
  }

  private updateMediaSessionState(): void {
    const session = this.session;
    if (!session) return;
    session.playbackState = this.playing ? 'playing' : 'paused';
    this.updateMediaSessionPosition();
  }

  private updateMediaSessionPosition(): void {
    const session = this.session;
    if (!session || typeof session.setPositionState !== 'function') return;
    const el = this.elements[this.activeSlot];
    const duration = el?.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: this.rate,
        position: Math.min(el!.currentTime, duration),
      });
    } catch {
      /* position state is optional */
    }
  }
}
