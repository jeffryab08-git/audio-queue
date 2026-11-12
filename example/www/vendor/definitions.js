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
export const PLAYBACK_STATE_DEFAULT = {
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
