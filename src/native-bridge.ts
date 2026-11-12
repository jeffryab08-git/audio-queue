/**
 * Thin, dependency-free bridge to the Capacitor native bridge.
 *
 * Capacitor injects `window.Capacitor.Plugins.MediaQueue` into the WebView once
 * a native implementation with `@CapacitorPlugin(name = "MediaQueue")` is
 * installed. We resolve it lazily so the same bundle also runs in a browser
 * (see web-engine.ts) and inside a plain WebView wrapper.
 */

import type {
  MediaQueueApi,
  MediaQueueEventMap,
  MediaQueueEventName,
  PlaybackState,
  RepeatMode,
  Track,
  Unsubscribe,
} from './definitions.js';
import { PLAYBACK_STATE_DEFAULT } from './definitions.js';

type ListenerHandle = { remove: () => Promise<void> | void };

interface RawCapacitorPlugin {
  setQueue(options: Record<string, unknown>): Promise<void>;
  addToQueue(options: Record<string, unknown>): Promise<void>;
  insertAfterCurrent(options: Record<string, unknown>): Promise<void>;
  insertAt(options: Record<string, unknown>): Promise<void>;
  removeAt(options: Record<string, unknown>): Promise<void>;
  move(options: Record<string, unknown>): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<{ state: PlaybackState }>;
  prev(): Promise<{ state: PlaybackState }>;
  seekTo(options: Record<string, unknown>): Promise<void>;
  setRepeatMode(options: Record<string, unknown>): Promise<void>;
  setVolume(options: Record<string, unknown>): Promise<void>;
  setPlaybackRate(options: Record<string, unknown>): Promise<void>;
  getState(): Promise<{ state: PlaybackState }>;
  getQueue(): Promise<{ tracks: Track[]; currentIndex: number }>;
  stop(): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  addListener(
    eventName: string,
    cb: (payload: unknown) => void,
  ): Promise<ListenerHandle> | ListenerHandle;
  removeAllListeners?(): Promise<void>;
}

export function getNativePlugin(): RawCapacitorPlugin | null {
  const g = globalThis as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      registerPlugin?: (name: string, impl?: Record<string, unknown>) => unknown;
      Plugins?: Record<string, unknown>;
    };
  };
  const cap = g.Capacitor;
  if (!cap) return null;

  const existing = cap.Plugins?.['MediaQueue'] as RawCapacitorPlugin | undefined;
  if (existing) return existing;

  // Capacitor >=4 exposes registerPlugin on window.Capacitor; calling it also
  // publishes the proxy on Capacitor.Plugins. Only do it on a native platform:
  // on the web build Capacitor would hand back a proxy whose calls reject.
  if (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() && typeof cap.registerPlugin === 'function') {
    try {
      const proxy = cap.registerPlugin('MediaQueue') as RawCapacitorPlugin | undefined;
      if (proxy) return proxy;
    } catch {
      return null;
    }
  }
  return null;
}

export function isNativePlatform(): boolean {
  const g = globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  if (typeof g.Capacitor?.isNativePlatform === 'function') return g.Capacitor.isNativePlatform();
  return getNativePlugin() !== null;
}

function normalizeState(raw: unknown): PlaybackState {
  const s = (raw ?? {}) as Partial<PlaybackState>;
  return {
    isPlaying: Boolean(s.isPlaying),
    isBuffering: Boolean(s.isBuffering),
    currentIndex: typeof s.currentIndex === 'number' ? s.currentIndex : -1,
    trackId: typeof s.trackId === 'string' ? s.trackId : null,
    position: typeof s.position === 'number' ? s.position : 0,
    duration: typeof s.duration === 'number' ? s.duration : 0,
    repeatMode: (s.repeatMode as RepeatMode) ?? 'off',
    queueLength: typeof s.queueLength === 'number' ? s.queueLength : 0,
    native: true,
  };
}

export class NativeMediaQueue implements MediaQueueApi {
  private readonly plugin: RawCapacitorPlugin;

  constructor(plugin: RawCapacitorPlugin) {
    this.plugin = plugin;
  }

  private async state(): Promise<PlaybackState> {
    const { state } = await this.plugin.getState();
    return normalizeState(state);
  }

  async setQueue(tracks: Track[], options: Record<string, unknown> = {}): Promise<void> {
    await this.plugin.setQueue({ tracks, ...options });
  }

  async addToQueue(track: Track): Promise<void> {
    await this.plugin.addToQueue({ track });
  }

  async insertAfterCurrent(track: Track): Promise<void> {
    await this.plugin.insertAfterCurrent({ track });
  }

  async insertAt(track: Track, index: number): Promise<void> {
    await this.plugin.insertAt({ track, index });
  }

  async removeAt(index: number): Promise<void> {
    await this.plugin.removeAt({ index });
  }

  async move(from: number, to: number): Promise<void> {
    await this.plugin.move({ from, to });
  }

  async play(): Promise<void> {
    await this.plugin.play();
  }

  async pause(): Promise<void> {
    await this.plugin.pause();
  }

  async next(): Promise<PlaybackState> {
    const res = await this.plugin.next();
    return normalizeState(res?.state);
  }

  async prev(): Promise<PlaybackState> {
    const res = await this.plugin.prev();
    return normalizeState(res?.state);
  }

  async seekTo(seconds: number): Promise<void> {
    await this.plugin.seekTo({ seconds });
  }

  async setRepeatMode(mode: RepeatMode): Promise<void> {
    await this.plugin.setRepeatMode({ mode });
  }

  async setVolume(volume: number): Promise<void> {
    await this.plugin.setVolume({ volume });
  }

  async setPlaybackRate(rate: number): Promise<void> {
    await this.plugin.setPlaybackRate({ rate });
  }

  getState(): Promise<PlaybackState> {
    return this.state();
  }

  getQueue(): Promise<{ tracks: Track[]; currentIndex: number }> {
    return this.plugin.getQueue();
  }

  async stop(): Promise<void> {
    await this.plugin.stop();
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return this.plugin.requestNotificationPermission();
  }

  async addListener<E extends MediaQueueEventName>(
    event: E,
    listener: (payload: MediaQueueEventMap[E]) => void,
  ): Promise<Unsubscribe> {
    const handle = await this.plugin.addListener(event, (payload: unknown) =>
      listener(payload as MediaQueueEventMap[E]),
    );
    return () => {
      // Synchronous removal: the handle promise is already awaited above, so the
      // channel closes before the caller's next line runs.
      try {
        const result = handle?.remove?.() as void | Promise<void> | undefined;
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(() => {});
        }
      } catch {
        /* already detached */
      }
    };
  }

  async removeAllListeners(): Promise<void> {
    await this.plugin.removeAllListeners?.();
  }

  static probe(): PlaybackState {
    return { ...PLAYBACK_STATE_DEFAULT, native: true };
  }
}
