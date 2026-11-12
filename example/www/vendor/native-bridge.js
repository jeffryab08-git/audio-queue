/**
 * Thin, dependency-free bridge to the Capacitor native bridge.
 *
 * Capacitor injects `window.Capacitor.Plugins.MediaQueue` into the WebView once
 * a native implementation with `@CapacitorPlugin(name = "MediaQueue")` is
 * installed. We resolve it lazily so the same bundle also runs in a browser
 * (see web-engine.ts) and inside a plain WebView wrapper.
 */
import { PLAYBACK_STATE_DEFAULT } from './definitions.js';
export function getNativePlugin() {
    const g = globalThis;
    const cap = g.Capacitor;
    if (!cap)
        return null;
    const existing = cap.Plugins?.['MediaQueue'];
    if (existing)
        return existing;
    // Capacitor >=4 exposes registerPlugin on window.Capacitor; calling it also
    // publishes the proxy on Capacitor.Plugins. Only do it on a native platform:
    // on the web build Capacitor would hand back a proxy whose calls reject.
    if (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() && typeof cap.registerPlugin === 'function') {
        try {
            const proxy = cap.registerPlugin('MediaQueue');
            if (proxy)
                return proxy;
        }
        catch {
            return null;
        }
    }
    return null;
}
export function isNativePlatform() {
    const g = globalThis;
    if (typeof g.Capacitor?.isNativePlatform === 'function')
        return g.Capacitor.isNativePlatform();
    return getNativePlugin() !== null;
}
function normalizeState(raw) {
    const s = (raw ?? {});
    return {
        isPlaying: Boolean(s.isPlaying),
        isBuffering: Boolean(s.isBuffering),
        currentIndex: typeof s.currentIndex === 'number' ? s.currentIndex : -1,
        trackId: typeof s.trackId === 'string' ? s.trackId : null,
        position: typeof s.position === 'number' ? s.position : 0,
        duration: typeof s.duration === 'number' ? s.duration : 0,
        repeatMode: s.repeatMode ?? 'off',
        queueLength: typeof s.queueLength === 'number' ? s.queueLength : 0,
        native: true,
    };
}
export class NativeMediaQueue {
    plugin;
    constructor(plugin) {
        this.plugin = plugin;
    }
    async state() {
        const { state } = await this.plugin.getState();
        return normalizeState(state);
    }
    async setQueue(tracks, options = {}) {
        await this.plugin.setQueue({ tracks, ...options });
    }
    async addToQueue(track) {
        await this.plugin.addToQueue({ track });
    }
    async insertAfterCurrent(track) {
        await this.plugin.insertAfterCurrent({ track });
    }
    async insertAt(track, index) {
        await this.plugin.insertAt({ track, index });
    }
    async removeAt(index) {
        await this.plugin.removeAt({ index });
    }
    async move(from, to) {
        await this.plugin.move({ from, to });
    }
    async play() {
        await this.plugin.play();
    }
    async pause() {
        await this.plugin.pause();
    }
    async next() {
        const res = await this.plugin.next();
        return normalizeState(res?.state);
    }
    async prev() {
        const res = await this.plugin.prev();
        return normalizeState(res?.state);
    }
    async seekTo(seconds) {
        await this.plugin.seekTo({ seconds });
    }
    async setRepeatMode(mode) {
        await this.plugin.setRepeatMode({ mode });
    }
    async setVolume(volume) {
        await this.plugin.setVolume({ volume });
    }
    async setPlaybackRate(rate) {
        await this.plugin.setPlaybackRate({ rate });
    }
    getState() {
        return this.state();
    }
    getQueue() {
        return this.plugin.getQueue();
    }
    async stop() {
        await this.plugin.stop();
    }
    async requestNotificationPermission() {
        return this.plugin.requestNotificationPermission();
    }
    async addListener(event, listener) {
        const handle = await this.plugin.addListener(event, (payload) => listener(payload));
        return () => {
            // Synchronous removal: the handle promise is already awaited above, so the
            // channel closes before the caller's next line runs.
            try {
                const result = handle?.remove?.();
                if (result && typeof result.catch === 'function') {
                    void result.catch(() => { });
                }
            }
            catch {
                /* already detached */
            }
        };
    }
    async removeAllListeners() {
        await this.plugin.removeAllListeners?.();
    }
    static probe() {
        return { ...PLAYBACK_STATE_DEFAULT, native: true };
    }
}
