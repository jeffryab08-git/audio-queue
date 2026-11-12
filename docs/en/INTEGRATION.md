# Integration, step by step

Starting point: a web app built in Google AI Studio that plays audio with `<audio>`
and changes tracks from JavaScript.

## Step 0 — Diagnosis: is this your case?

Look for something like this in your code:

```js
audio.addEventListener('ended', () => { playNext(); });
// or
useEffect(() => { if (status.didJustFinish) playNext(); }, [status]);
// or
onEnded={() => setIndex(i => i + 1)}
```

If the next track is assigned from JS when the current one ends, the symptom with the
screen locked is exactly the one described. The fix is **not** a timer and **not** a
wake lock: it is to stop deciding the transition in JS.

## Step 1 — Use the module on the web (no build changes)

Copy `dist/esm/` into your project (or install the package) and replace the player:

```js
import { createMediaQueue } from './vendor/index.js';

const queue = createMediaQueue();          // native if available, web if not

const tracks = songs.map((s) => ({
  id: s.id,
  url: s.audioUrl,
  title: s.title,
  artist: s.artist,
  album: s.album,
  artwork: s.coverUrl,
}));

// ONE call: from here on the queue belongs to the engine
await queue.setQueue(tracks, { startIndex: 0, autoplay: false });

// Controls
playBtn.onclick   = () => queue.play();
pauseBtn.onclick  = () => queue.pause();
nextBtn.onclick   = () => queue.next();
prevBtn.onclick   = () => queue.prev();
seekBar.oninput   = () => queue.seekTo(seekBar.value);

// UI
await queue.addListener('trackChanged', (e) => renderNowPlaying(e.track, e.index));
await queue.addListener('stateChanged', (s) => renderTransport(s));
await queue.addListener('queueChanged', (q) => renderList(q.tracks, q.currentIndex));
await queue.addListener('error', (e) => showToast(`${e.code}: ${e.message}`));
```

Delete the `ended` handler and anything that calls `playNext()` from JS. If you keep
both (`ended` + `trackChanged`) you will get double skips.

### Re-syncing the UI when the app comes back

With the screen locked the WebView may be frozen and events are lost. On return:

```js
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    const state = await queue.getState();
    renderTransport(state);
    const { tracks, currentIndex } = await queue.getQueue();
    renderList(tracks, currentIndex);
  }
});
```

## Step 2 — Turn it into an installable app with Capacitor

If your app is already exported as a static web app (`dist/` or `www/`):

```bash
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "My App" com.mycompany.app --web-dir=www
npm i capacitor-media-queue          # or "file:../audio-queue" while developing
npx cap add android
npx cap add ios
npx cap sync
```

`npx cap sync` discovers the plugin through the `capacitor` block of its
`package.json` and generates `android/capacitor.settings.gradle` pointing at the
module. No manual Gradle edits.

### Android

The plugin's `AndroidManifest.xml` already declares the permissions and the service;
Gradle's manifest merge pulls them in. You only need to make sure of:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

and request the permission at runtime (the plugin does it for you):

```js
const { granted } = await queue.requestNotificationPermission();
```

If your `targetSdk >= 34`, the service must carry `foregroundServiceType="mediaPlayback"`
(already in the plugin manifest).

### iOS

1. `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

2. In Xcode: *Signing & Capabilities* → **+ Capability** → *Background Modes* → check
   *Audio, AirPlay, and Picture in Picture*.
3. `npx cap sync ios` and `pod install` (Capacitor 7) or SPM resolution (Capacitor 8).

## Step 3 — Verify on a device

```bash
npx cap run android          # or open the project in Android Studio
```

Acceptance test:

1. Playlist of ≥ 5 tracks.
2. Play, then lock with the power button.
3. Listen: every ~N seconds the next track must start without touching the phone.
4. Pull the notification down: it must show title/artist and respond to
   play/pause/next.
5. Call the phone: audio pauses; on hang-up it resumes.

On Android you can follow the demo's trace in logcat:

```bash
adb logcat | grep -E "MediaQueueDemo|ExoPlayerImplInternal"
```

## Integration notes

- **Do not instantiate two engines.** `createMediaQueue()` must be called once and
  shared (context/store/module singleton). Two instances on the web create four
  `<audio>` elements.
- **Do not reorder the queue by hand in your own state.** Use `addToQueue`, `insertAt`,
  `removeAt`, `move`: the native engine and your UI stay aligned.
- **Stable IDs.** `Track.id` is used as the cache key; if it changes between sessions
  the track is downloaded twice.
- **URLs reachable from the device.** `localhost` on the phone is not your laptop. For
  tests use `http://10.0.2.2:8099/` (Android emulator) or your machine's IP.
- **CORS**: it does not apply on native (the request is made by ExoPlayer/AVFoundation,
  not the browser); it does apply to the web fallback, and the server must allow `Range`
  and expose `Accept-Ranges`.
- **If you already use `@capgo/capacitor-native-audio`** and its queue API is enough for
  you, you can stay with it: this module exists for control over preload, retries and
  the MIT license, not because that one does not work.

## Migrating from the current pattern (conceptual diff)

```diff
- audio.src = tracks[index].url;
- audio.play();
+ await queue.setQueue(tracks, { startIndex: index, autoplay: true });

- audio.addEventListener('ended', () => {
-   index += 1;
-   audio.src = tracks[index].url;   // freezes in the background
-   audio.play();
- });
+ // nothing: the native engine advances on its own. The UI learns via trackChanged.

- setInterval(updateProgress, 250);   // throttled in the background
+ queue.addListener('progress', updateProgress);   // UI only
```
