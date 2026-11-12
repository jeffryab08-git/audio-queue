# Investigation: why the next track never starts while the screen is off

Phase 1 report. Every platform claim below is anchored to official documentation
(see `docs/en/SOURCES.md` for the full list).

## 1. Restating the symptom

The app plays the current track fine with the screen locked, but the **next track**
never starts (infinite buffering, cuts out after a few seconds, or total silence) —
and it **does** start the instant you unlock the screen.

That "plays when you unlock" is the signature of **deferred execution**, not of a
dropped connection or a bad URL: the request that starts the next track is sitting in
a queue and the system runs it once the app is visible again. In other words, the code
that decides "what plays next" runs in a context the OS is entitled to freeze:
JavaScript inside the WebView.

## 2. Android

### 2.1 What Doze actually does

Doze engages when the device is unplugged, stationary and the screen is off, and it
applies these restrictions to apps:[1]

- Suspends network access.
- **Ignores wake locks** (`PowerManager.WakeLock`).
- Defers standard alarms (`setExact()`, `setWindow()`) to the maintenance window.
- Does not run `JobScheduler`.
- Blocks sync adapters and Wi-Fi scans.

The "ignores wake locks" detail is the most misunderstood one in forum threads: **a
partial wake lock will not save an app in Doze**. It is not a valid "resist Doze"
tool; it is a tool to keep the CPU awake *while the app is still allowed to run*.

### 2.2 The exemption that does exist: foreground service

The per-process-state limits table is explicit: for an app **whose process runs a
foreground service** the network column says **"No restrictions"**; with the screen
off and Doze active, a normal app gets **"Restricted during doze"**.[2]

That means the only supported way to keep the network usable with the screen off is
for the process to be classified as a foreground service — and for audio that means
`MediaSessionService` with `foregroundServiceType="mediaPlayback"`, which requires
`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`.[3]

### 2.3 Why the "JS swaps the src at the end" pattern fails

An `<audio>` element inside a WebView (or a player driven from JS in a wrapper) does
the transition on the JavaScript thread:

```js
audio.addEventListener('ended', () => { audio.src = queue[++i].url; audio.play(); });
```

With the screen off the WebView stops getting frames and its renderer is frozen or
severely throttled; on top of that the system may defer the process's network work
when it is not a foreground service. Result: the `ended` event arrives late, or the
following `play()` has no network/CPU, and the transition stays stuck. Unlock the
screen and the renderer resumes and runs the pending handler — exactly the reported
symptom.

Worth stating precisely: even if the WebView stays "alive" because audio is playing,
the decision of *what* to play next still depends on a JS callback the OS has no
obligation to run on time.

### 2.4 Where timers can be trusted

Nowhere. `setTimeout`/`setInterval` are throttled in background and subject to renderer
freezing. The design consequence is that **the track change must not depend on any
timer or any JS callback**.

## 3. iOS

### 3.1 What enables background audio

`AVAudioSession.Category.playback` documents that audio continues with the silent
switch on and when the screen locks, and that to keep playing when the app goes to
the background you must add `audio` to `UIBackgroundModes` in `Info.plist`.[5]

With that combination iOS **does not suspend** the process while an audio session is
actively playing. That is why the current track keeps playing.

### 3.2 Why the next one does not start

`AVQueuePlayer` exists precisely for this: it manages a queue of `AVPlayerItem`s and
advances on its own.[6] The problem appears when the app **does not** use a native
queue and instead does the same thing as on the web: listen for the end of the item
and swap the asset from app code. If that swap happens on the WebView thread
(Capacitor/Cordova) or in a callback iOS chooses not to run while the device is
locked, playback runs out of a next item.

Second, iOS-specific failure mode: if the `AVPlayer` has no items queued when the
current one ends, the audio session goes silent, iOS may deactivate it and suspend the
process — and there is nobody left to load the next track.

### 3.3 Key Android vs iOS difference

- **Android**: the risk is the network (Doze) and the renderer (WebView). Solved with a
  foreground service plus a native queue.
- **iOS**: the network is not cut while the audio session is active; the risk is
  running **out of queued items** while the "next" logic lives in a context that may
  not execute. Solved with `AVQueuePlayer` plus a 2-item window maintained by native
  code.

## 4. Web / PWA

- **Media Session API** lets you publish metadata and handle play/pause/next from the
  notification and the lock screen.[7] It grants no execution rights: if the page is
  frozen, handlers do not run.
- **Screen Wake Lock API** keeps the screen on, but the lock is released when the
  document stops being visible;[8] it is useless for background audio, and keeping the
  screen on is the opposite of the goal anyway.
- **Service Worker**: it cannot start playback on its own nor keep a frozen page alive.
  It is good for caching the shell and the audio, not for continuity.
- Conclusion: the web fallback is acceptable on desktop and desktop PWAs, and is
  **structurally incapable** of guaranteeing continuity with the screen off on mobile.

## 5. Existing open-source solutions

| Project | Platform | License | Status | Does it solve the case? |
|---|---|---|---|---|
| `react-native-track-player` v4.1.2 | RN (Android/iOS) | Apache-2.0[10] | maintained (v4 on the `v4` branch) | Yes: native queue, foreground service, controls. **Note: v5 moved to a commercial license**[9] |
| `expo-audio` 58.x (`AudioPlaylist`) | Expo/RN | MIT | actively maintained | Partly/yes: native playlist + preload; on Android it requires `setActiveForLockScreen` or audio stops after ~3 min[11] |
| `@capgo/capacitor-native-audio` | Capacitor 7/8 | MPL-2.0[12] | very active (daily commits) | Yes: `setQueue()`, lock-screen skip, background, HLS |
| `@mediagrid/capacitor-native-audio` | Capacitor 7/8 | MIT[13] | active | Partly: background playback with a notification, but the API is single-asset (`changeAudioSource`), not a queue |
| Media3 `MediaSessionService` | native Android | Apache-2.0[14] | maintained by Google | It is the engine, not the solution: you still write the service, queue and preload |
| `AVQueuePlayer` | native iOS | system framework | — | It is the engine, not the solution |

## 6. Hermes verdict

1. **The problem is not Doze itself.** Doze is the environment; the bug is
   architectural: the track transition lives in JavaScript.
2. **Ready-made solutions do exist.** The most direct one for an app already built as a
   web app is `@capgo/capacitor-native-audio` (MPL-2.0, native `setQueue()`). For a
   React Native project, `react-native-track-player` v4 (Apache-2.0) solves the same
   thing.
3. **What did not exist as-is** is a piece meeting *every* requirement of this brief
   under an MIT license and auditable code: native queue + explicit next-track preload
   into cache + retries with backoff + dynamic queue + web fallback in one package.
   That is what was built here.
4. **The recommended combination** is: a native engine that owns the queue (Media3 /
   AVQueuePlayer) + next-item preload + foreground service / background mode + media
   notification; JS only as a remote control for the UI.
