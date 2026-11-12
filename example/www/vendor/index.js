/**
 * Entry point.
 *
 * `createMediaQueue()` returns the native engine when a MediaQueue native
 * implementation is present (Android/iOS Capacitor shell) and the web engine
 * otherwise, so the same application code runs in the Google AI Studio preview,
 * a browser, a PWA and the installed app.
 */
import { getNativePlugin, isNativePlatform, NativeMediaQueue } from './native-bridge.js';
import { WebMediaQueue } from './web-engine.js';
export * from './definitions.js';
export { QueueCore } from './queue-core.js';
export { WebMediaQueue } from './web-engine.js';
export { NativeMediaQueue, getNativePlugin, isNativePlatform } from './native-bridge.js';
export function createMediaQueue(options = {}) {
    if (options.force !== 'web') {
        const plugin = getNativePlugin();
        if (plugin)
            return new NativeMediaQueue(plugin);
    }
    return new WebMediaQueue(options);
}
/** True when the native engine is available and will be used. */
export function hasNativeEngine() {
    return getNativePlugin() !== null && isNativePlatform();
}
