/**
 * Thin, dependency-free bridge to the Capacitor native bridge.
 *
 * Capacitor injects `window.Capacitor.Plugins.MediaQueue` into the WebView once
 * a native implementation with `@CapacitorPlugin(name = "MediaQueue")` is
 * installed. We resolve it lazily so the same bundle also runs in a browser
 * (see web-engine.ts) and inside a plain WebView wrapper.
 */
import type { MediaQueueApi, MediaQueueEventMap, MediaQueueEventName, PlaybackState, RepeatMode, Track, Unsubscribe } from './definitions.js';
type ListenerHandle = {
    remove: () => Promise<void> | void;
};
interface RawCapacitorPlugin {
    setQueue(options: Record<string, unknown>): Promise<void>;
    addToQueue(options: Record<string, unknown>): Promise<void>;
    insertAfterCurrent(options: Record<string, unknown>): Promise<void>;
    insertAt(options: Record<string, unknown>): Promise<void>;
    removeAt(options: Record<string, unknown>): Promise<void>;
    move(options: Record<string, unknown>): Promise<void>;
    play(): Promise<void>;
    pause(): Promise<void>;
    next(): Promise<{
        state: PlaybackState;
    }>;
    prev(): Promise<{
        state: PlaybackState;
    }>;
    seekTo(options: Record<string, unknown>): Promise<void>;
    setRepeatMode(options: Record<string, unknown>): Promise<void>;
    setVolume(options: Record<string, unknown>): Promise<void>;
    setPlaybackRate(options: Record<string, unknown>): Promise<void>;
    getState(): Promise<{
        state: PlaybackState;
    }>;
    getQueue(): Promise<{
        tracks: Track[];
        currentIndex: number;
    }>;
    stop(): Promise<void>;
    requestNotificationPermission(): Promise<{
        granted: boolean;
    }>;
    addListener(eventName: string, cb: (payload: unknown) => void): Promise<ListenerHandle> | ListenerHandle;
    removeAllListeners?(): Promise<void>;
}
export declare function getNativePlugin(): RawCapacitorPlugin | null;
export declare function isNativePlatform(): boolean;
export declare class NativeMediaQueue implements MediaQueueApi {
    private readonly plugin;
    constructor(plugin: RawCapacitorPlugin);
    private state;
    setQueue(tracks: Track[], options?: Record<string, unknown>): Promise<void>;
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
    static probe(): PlaybackState;
}
export {};
