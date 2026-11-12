/**
 * Entry point.
 *
 * `createMediaQueue()` returns the native engine when a MediaQueue native
 * implementation is present (Android/iOS Capacitor shell) and the web engine
 * otherwise, so the same application code runs in the Google AI Studio preview,
 * a browser, a PWA and the installed app.
 */
import type { MediaQueueApi } from './definitions.js';
import { type WebEngineOptions } from './web-engine.js';
export * from './definitions.js';
export { QueueCore, type AdvanceResult } from './queue-core.js';
export { WebMediaQueue, type WebEngineOptions, type AudioLike } from './web-engine.js';
export { NativeMediaQueue, getNativePlugin, isNativePlatform } from './native-bridge.js';
export interface CreateMediaQueueOptions extends WebEngineOptions {
    /** Force a backend. `undefined` = auto (native when available). */
    force?: 'native' | 'web';
}
export declare function createMediaQueue(options?: CreateMediaQueueOptions): MediaQueueApi;
/** True when the native engine is available and will be used. */
export declare function hasNativeEngine(): boolean;
