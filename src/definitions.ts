/**
 * Public type surface of capacitor-media-queue.
 *
 * The same contract is implemented three times:
 *  - Android  -> MediaQueuePlugin.kt (Media3 ExoPlayer + MediaSessionService)
 *  - iOS      -> MediaQueuePlugin.swift (AVQueuePlayer + MPRemoteCommandCenter)
 *  - Web      -> web-engine.ts (HTMLAudioElement double buffer + Media Session API)
 *
 * Nothing here depends on @capacitor/core at runtime: the native bridge is
 * resolved from `window.Capacitor.Plugins.MediaQueue`, which the Capacitor
 * runtime injects into the WebView. That keeps the module usable from a plain
 * <script type="module"> page too (see /web and /example).
 */

export interface Track {
  /** Stable identifier. Must be unique inside a queue; used as cache key. */
  id: string;
  /** http(s) URL of the audio file. Local file:// / capacitor:// URLs also work on native. */
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  /** Artwork URL shown in the notification / lock screen. */
  artwork?: string;
  /** Duration in seconds when known up front (web fallback uses it before metadata loads). */
  duration?: number;
  /** Extra request headers for this track (native only; the web engine ignores them). */
  headers?: Record<string, string>;
}

export type RepeatMode = 'off' | 'track' | 'queue';

export interface SetQueueOptions {
  /** Index of the track that starts playing. Default 0. */
  startIndex?: number;
  /** Start position in seconds. Default 0. */
  startPosition?: number;
  /** Start playing immediately. Default true. */
  autoplay?: boolean;
  /** Global headers applied to every request (native only). */
  headers?: Record<string, string>;
}

export interface PlaybackState {
  isPlaying: boolean;
  isBuffering: boolean;
  /** -1 when the queue is empty. */
  currentIndex: number;
  trackId: string | null;
  /** Seconds. */
  position: number;
  /** Seconds; 0 while unknown. */
  duration: number;
  repeatMode: RepeatMode;
  queueLength: number;
  /** True when the active engine is the native one (Android/iOS), false for the web fallback. */
  native: boolean;
}

export interface TrackChangedEvent {
  index: number;
  track: Track | null;
  /** True when the engine advanced by itself at end of track (not a user skip). */
  automatic: boolean;
  /** 'ended' | 'next' | 'prev' | 'queue' | 'error' */
  reason: 'ended' | 'next' | 'prev' | 'queue' | 'error';
  state: PlaybackState;
}

export interface QueueErrorEvent {
  code:
    | 'NETWORK'
    | 'DECODE'
    | 'NOT_FOUND'
    | 'ABORTED'
    | 'PERMISSION'
    | 'UNKNOWN';
  message: string;
  /** Track that failed, when known. */
  trackId?: string;
  /** How many automatic retries already happened for this track. */
  retries: number;
  fatal: boolean;
}

export type MediaQueueEventMap = {
  /** Fired when the active track changes, including engine-driven auto-advance. */
  trackChanged: TrackChangedEvent;
  /** Fired on play/pause/buffer/repeat changes and on resume (state is re-read from native). */
  stateChanged: PlaybackState;
  /** Fired after any queue mutation, with the full queue. */
  queueChanged: { tracks: Track[]; currentIndex: number };
  /** Non-fatal errors are reported and retried; fatal ones stop playback. */
  error: QueueErrorEvent;
  /** Periodic progress while playing. Interval is a UI concern only. */
  progress: { position: number; duration: number; trackId: string | null };
};

export type MediaQueueEventName = keyof MediaQueueEventMap;

export type Unsubscribe = () => void;

/**
 * Unified JavaScript API. Both the native and the web implementation satisfy it.
 *
 * Design rule that makes background playback work: the queue is handed to the
 * engine *once* (`setQueue`) and the engine owns the transition between tracks.
 * JS never assigns `audio.src = nextTrack` on an `ended` event, because in
 * background that event may be delivered seconds late or not at all.
 */
export interface MediaQueueApi {
  /** Replace the whole queue. The engine builds its native queue in one call. */
  setQueue(tracks: Track[], options?: SetQueueOptions): Promise<void>;
  /** Append at the end of the queue. */
  addToQueue(track: Track): Promise<void>;
  /** Insert right after the current track (classic "play next"). */
  insertAfterCurrent(track: Track): Promise<void>;
  /** Insert at an absolute index. */
  insertAt(track: Track, index: number): Promise<void>;
  removeAt(index: number): Promise<void>;
  move(from: number, to: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Skip forward. Returns the new state. */
  next(): Promise<PlaybackState>;
  /** Skip back. */
  prev(): Promise<PlaybackState>;
  seekTo(seconds: number): Promise<void>;
  setRepeatMode(mode: RepeatMode): Promise<void>;
  /** 0..1 */
  setVolume(volume: number): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  getState(): Promise<PlaybackState>;
  getQueue(): Promise<{ tracks: Track[]; currentIndex: number }>;
  stop(): Promise<void>;
  /** Ask for POST_NOTIFICATIONS on Android 13+. No-op elsewhere. Resolves to the grant state. */
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  addListener<E extends MediaQueueEventName>(
    event: E,
    listener: (payload: MediaQueueEventMap[E]) => void,
  ): Promise<Unsubscribe>;
  removeAllListeners(): Promise<void>;
}

export const PLAYBACK_STATE_DEFAULT: PlaybackState = {
  isPlaying: false,
  isBuffering: false,
  currentIndex: -1,
  trackId: null,
  position: 0,
  duration: 0,
  repeatMode: 'off',
  queueLength: 0,
  native: false,
};
