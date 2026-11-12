# Fuentes

Documentación y repositorios citados en `docs/RESEARCH.md`.

1. Optimize for Doze and App Standby — https://developer.android.com/training/monitoring-device-state/doze-standby
2. Power management resource limits (tabla por estado de proceso) — https://developer.android.com/topic/performance/power/power-details
3. Background playback with a MediaSessionService — https://developer.android.com/media/media3/session/background-playback
4. ExoPlayer API reference (`setWakeMode`, `setAudioAttributes`, `setHandleAudioBecomingNoisy`) — https://developer.android.com/reference/androidx/media3/exoplayer/ExoPlayer
5. `AVAudioSession.Category.playback` (audio con pantalla bloqueada + `UIBackgroundModes`) — https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback
6. `AVQueuePlayer` — https://developer.apple.com/documentation/avfoundation/avqueueplayer
7. MDN `MediaSession` — https://developer.mozilla.org/en-US/docs/Web/API/MediaSession
8. MDN Screen Wake Lock API — https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
9. `react-native-track-player` (README: v5 con licencia comercial, v4 en rama `v4`) — https://github.com/doublesymmetry/react-native-track-player
10. `react-native-track-player` en npm (v4.1.2, Apache-2.0) — https://www.npmjs.com/package/react-native-track-player
11. `expo-audio` (nota: en Android hace falta `setActiveForLockScreen` o el audio se corta a los ~3 minutos) — https://docs.expo.dev/versions/latest/sdk/audio/
12. `@capgo/capacitor-native-audio` (MPL-2.0, `setQueue`, lock screen) — https://github.com/Cap-go/capacitor-native-audio
13. `@mediagrid/capacitor-native-audio` (MIT, un solo asset) — https://github.com/mediagrid/capacitor-native-audio
14. `androidx/media` (Media3, Apache-2.0) — https://github.com/androidx/media

## Dependencias del código entregado

| Dependencia | Versión | Licencia |
|---|---|---|
| `androidx.media3:media3-exoplayer` | 1.8.0 | Apache-2.0 |
| `androidx.media3:media3-session` | 1.8.0 | Apache-2.0 |
| `androidx.media3:media3-datasource` | 1.8.0 | Apache-2.0 |
| `androidx.media3:media3-database` | 1.8.0 | Apache-2.0 |
| `androidx.media3:media3-common` | 1.8.0 | Apache-2.0 |
| `androidx.core:core-ktx` | 1.13.1 | Apache-2.0 |
| `org.jetbrains.kotlin:kotlin-stdlib` | 2.1.0 | Apache-2.0 |
| `@capacitor/core` / `@capacitor/android` | 7.x / 8.x | MIT |
| AVFoundation, MediaPlayer, UIKit (iOS) | sistema | framework del sistema |
| Media Session API, Screen Wake Lock API | estándar W3C | — |
| `typescript` (dev) | 5.x | Apache-2.0 |
