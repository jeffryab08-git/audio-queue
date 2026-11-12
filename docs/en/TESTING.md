# Testing: what was actually verified

Everything below was executed in this environment (Linux, JDK 21, Android SDK 36,
`android-34 google_apis x86_64` emulator). What could not be run is stated
explicitly.

## 1. TypeScript: 25/25 tests green

```bash
npm run build          # tsc -p tsconfig.json  (strict, no errors)
node --test test/      # 25 tests
```

```
ℹ tests 25
ℹ pass 25
ℹ fail 0
```

Test coverage:

- `test/queue-core.test.mjs` (9): automatic advance, `repeat` off/track/queue, manual
  skip without wrap, `insertAt`/`removeAt`/`move` while keeping the current track,
  immutable snapshots.
- `test/web-engine.test.mjs` (12): the 5-track queue advances completely **without
  external intervention**; the switch uses the preloaded element (0 extra `load()`
  calls); the swap takes < 250 ms (measured, usually < 1 ms); `repeat`; retries with
  backoff until a fatal error; `play()` rejection reported as `PERMISSION`; consistent
  queue mutations.
- `test/native-bridge.test.mjs` (4): no Capacitor → web engine; Capacitor web platform
  (Google AI Studio preview) → web engine; native platform → every call is forwarded
  with the exact shape Kotlin/Swift expect; `addListener` and its `unsubscribe` work;
  `registerPlugin` is used when `Plugins` is not populated.

## 2. Android: APK built

```bash
cd example/android
JAVA_HOME=~/jdk21 ./gradlew :app:assembleDebug
# BUILD SUCCESSFUL — app/build/outputs/apk/debug/app-debug.apk (8.7 MB)
```

Capacitor 8.6.0, AGP 8.13.0, Gradle 8.14.3, compileSdk 36, Media3 1.8.0, Kotlin 2.1.0.
The plugin is included as a normal Gradle project (`capacitor.settings.gradle` resolves
it from `../../android`).

Real bugs found and fixed while building:

1. `Player is accessed on the wrong thread` — Capacitor invokes plugin methods on its
   own `CapacitorPlugins` HandlerThread and ExoPlayer is confined to the thread that
   created it. **Fixed** by marshalling everything to `Looper.getMainLooper()`
   (`PlaybackHub.run`/`onMain`). This crash only shows up on a device, never in code
   review.
2. `C.LENGTH_UNSET` is `int` (not `long`) in Media3 → `DataSpec` with `toLong()`.
3. `ExoPlayer.setMediaSourceFactory` does not exist on the instance (builder only) →
   replaced by `DynamicHttpDataSourceFactory`, which applies headers per request without
   rebuilding the player.
4. `play()` after `STATE_ENDED` did nothing → it now restarts from the beginning.

## 3. Android on the emulator: playback with the screen off and Doze forced

Scenario: five 6 s WAV tracks served over HTTP (`python3 -m http.server 8099`), app
installed, `POST_NOTIFICATIONS` granted, `adb shell input tap` on play.

Test A — screen off + Doze forced:

```bash
adb shell input keyevent 26                  # screen off
adb shell dumpsys battery unplug
adb shell dumpsys deviceidle force-idle      # Doze immediately
adb shell dumpsys power   | grep mWakefulness   # -> Asleep
adb shell dumpsys deviceidle | grep mState      # -> IDLE
```

Transitions observed in logcat **with the screen off and the device in Doze IDLE**
(6 s tracks; the track titles come from the Spanish demo page, which is the default
entry point):

```
17:07:37.447  trackChanged → #2 Tono C #3 (ended, automatic)
17:07:43.448  trackChanged → #3 Tono D #4 (ended, automatic)
17:07:49.456  trackChanged → #4 Tono E #5 (ended, automatic)
```

Drift from the theoretical end of the previous track: **1 ms, 1 ms, 8 ms**. The
acceptance criterion asked for < 2 s. Playback finished the whole list without
unlocking the screen.

Test B — media controls with the screen off:

```bash
adb shell cmd media_session dispatch next    # -> trackChanged → #1 (next)
adb shell cmd media_session dispatch pause
adb shell cmd media_session dispatch play
```

Resulting state (`dumpsys media_session`):

```
package=com.hermes.mediaqueue.demo
active=true
state=PlaybackState {state=PLAYING(3), position=3967, buffered position=6000, speed=1.0,
                     active item id=1, error=null}
audioAttrs=AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_MUSIC
metadata: description=Tono B #2, Demo · 494 Hz, MediaQueue demo
queue size=5
controllers: 4    mediaButtonReceiver=<set>
```

This verifies: active session, metadata in the notification, queue exposed to the
system, audio focus with the right attributes, and media buttons routed.

Test C — wake lock and preload:

```
PARTIAL_WAKE_LOCK 'ExoPlayer:WakeLockManager' ACQ=-3s26ms (uid=10192)
adb shell run-as com.hermes.mediaqueue.demo du -sh cache/media-queue-cache
1.3M   cache/media-queue-cache        # 5 tracks preloaded/cached
```

Later tracks played **from cache**, not from the network: that is why Doze cannot break
the transition.

## 4. iOS: NOT verified here

There is no Swift toolchain in this environment. What was done:

- Review against the official documentation of `AVQueuePlayer`, `AVAudioSession`
  (category `.playback` + `UIBackgroundModes: audio`), `MPRemoteCommandCenter` and
  `MPNowPlayingInfoCenter`.
- All queue mutations confined to `DispatchQueue.main`.
- `Package.swift` (Capacitor 8, SPM) and `MediaQueue.podspec` (Capacitor 7, CocoaPods)
  configured.

Checklist to validate it on a Mac (30 min):

```bash
# 1. demo app
cd example && npm i && cp -r www android 2>/dev/null
npx cap add ios && npx cap sync ios
# 2. open in Xcode, enable "Audio, AirPlay and Picture in Picture" under
#    Signing & Capabilities > Background Modes
# 3. serve the tracks: in example/www/audio -> python3 -m http.server 8099
#    and in the app use ?base=http://<mac-ip>:8099/  (or change defaultBase)
# 4. run on a device, play, lock with the power button
# 5. wait 5 tracks x 6 s and check Xcode > Devices > Console:
#    "trackChanged" every 6 s, and Now Playing advancing on the lock screen
```

iOS success criterion: 4 automatic transitions with the device locked and the next
track audible in < 2 s.

## 5. What has not been tested

| Requirement | Status |
|---|---|
| 5-track playlist with the screen off (Android) | **Verified** |
| Transition < 2 s without unlocking | **Verified (1–8 ms)** |
| Notification with controls | **Verified** (`dumpsys media_session`, dispatch) |
| Wake lock during buffering/playback | **Verified** (`dumpsys power`) |
| Next-track preload | **Verified** (1.3 MB in `SimpleCache`) |
| Audio focus / pause on call | Implemented with the standard API (`handleAudioFocus = true`), **not exercised** (the emulator has no telephony) |
| Audible output through the speaker | **Not verified**: the emulator ran without a host audio backend (`pulseaudio: Failed to initialize PA context`). Verification was by engine state: `state=PLAYING(3)`, `position` advancing, `automatic` transitions and tracks served from `SimpleCache` — proof that the pipeline decodes and advances, not that it is audible. Check on a real device |
| Full iOS | **Not compiled** (no Xcode here) |
| PWA on a real phone | **No** — by design it does not guarantee continuity |
