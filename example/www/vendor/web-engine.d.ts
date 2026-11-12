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
import type { MediaQueueApi, MediaQueueEventMap, MediaQueueEventName, PlaybackState, RepeatMode, SetQueueOptions, Track, Unsubscribe } from './definitions.js';
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
    artwork: {
        src: string;
        sizes: string;
    }[];
}
export declare class WebMediaQueue implements MediaQueueApi {
    private readonly core;
    private readonly options;
    private readonly listeners;
    /** Two elements, alternating. `activeSlot` is the one currently audible. */
    private elements;
    private activeSlot;
    private preloadedSlot;
    private preloadedIndex;
    private retries;
    private volume;
    private rate;
    private progressTimer;
    private retryTimer;
    private playing;
    private buffering;
    private disposed;
    /** Set while we swap elements, so the old element's `pause` is not reported as a user pause. */
    private swapping;
    constructor(options?: WebEngineOptions);
    private get active();
    private get inactive();
    private ensureElements;
    private wire;
    setQueue(tracks: Track[], options?: SetQueueOptions): Promise<void>;
    addToQueue(track: Track): Promise<void>;
    insertAfterCurrent(track: Track): Promise<void>;
    insertAt(track: Track, index: number): Promise<void>;
    removeAt(index: number): Promise<void>;
    move(from: number, to: number): Promise<void>;
    play(): Promise<void>;
    pause(): Promise<void>;
    next(): Promise<PlaybackState>;
    prev(): Promise<PlaybackState>;
    seekTo(seconds: number): Promise<void>;
    setRepeatMode(mode: RepeatMode): Promise<void>;
    setVolume(volume: number): Promise<void>;
    setPlaybackRate(rate: number): Promise<void>;
    getState(): Promise<PlaybackState>;
    getQueue(): Promise<{
        tracks: Track[];
        currentIndex: number;
    }>;
    stop(): Promise<void>;
    requestNotificationPermission(): Promise<{
        granted: boolean;
    }>;
    addListener<E extends MediaQueueEventName>(event: E, listener: (payload: MediaQueueEventMap[E]) => void): Promise<Unsubscribe>;
    removeAllListeners(): Promise<void>;
    dispose(): void;
    private loadInto;
    private startPlayback;
    /** Called by the element's own `ended` event — the only clock we trust. */
    private handleEnded;
    /**
     * Swap to an already-preloaded element when possible: no network round trip,
     * no gap. Falls back to loading the track in place.
     */
    private transitionTo;
    private preloadNext;
    private handleError;
    private state;
    private startProgress;
    private stopProgress;
    private emitState;
    private emitQueue;
    private emitTrackChanged;
    private emitError;
    private get session();
    private setMediaSessionMetadata;
    private handlersRegistered;
    private registerActionHandlers;
    private updateMediaSessionState;
    private updateMediaSessionPosition;
}
