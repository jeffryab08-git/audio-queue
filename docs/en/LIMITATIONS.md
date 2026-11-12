# Known limitations

## Android

1. **Doze is still there.** It is not eliminated, it is bypassed the supported way (a
   `mediaPlayback` foreground service, the only process state with "No restrictions" on
   network). If the user revokes the notification permission (Android 13+) the service
   loses visibility and the system may treat it worse.
2. **Wake locks do not protect against Doze.** Doze ignores wake locks. ExoPlayer's wake
   lock (`setWakeMode(C.WAKE_MODE_NETWORK)`) keeps CPU and radio awake while playing,
   but it is not what saves the transition: the foreground service plus the preload do
   that.
3. **Starting from the background.** On Android 12+ an app cannot start the service from
   the background. Every plugin call assumes the app is in the foreground (the user
   pressed play) or that the service is already alive. If `play()` is invoked from a
   cold push notification, the command is queued until the app returns to the
   foreground.
4. **Per-track headers** are applied per request (`DynamicHttpDataSourceFactory`), which
   covers simple signed URLs. Tokens that change *per range* (e.g. a signature that
   expires mid-download) require a custom `ResolvingDataSource`.
5. **Cache and `Content-Length`**: `CacheWriter` needs to know the body size or read
   until EOF. Servers that send neither `Content-Length` nor chunked responses over
   `Range` can leave the preload incomplete (it does not break playback, only the
   optimization).
6. **Persistence**: the queue is restored paused, never playing. Resurrecting audio
   without a user gesture is hostile and Android would reject the FGS.

## iOS

1. **Not compiled in this environment.** The module is written against the documented
   public APIs, but this repository was built and validated on Linux: there is no
   `swiftc`/Xcode available. Compiling and running it on a real device is the pending
   step (see `docs/en/TESTING.md`).
2. **Per-track HTTP headers are not supported.** The only route is
   `AVURLAssetHTTPHeaderFieldsKey`, an undocumented option that risks App Review
   rejection. Put tokens in the URL or sign at the CDN level.
3. **2-item window**: if `preferredForwardBufferDuration` (10 s) is not enough for a
   network change, `automaticallyWaitsToMinimizeStalling = true` makes it wait (which is
   correct: better a short pause than a failure).
4. **Repeat is implemented by refilling**: `AVQueuePlayer` has no `repeatMode`; the queue
   is refilled with the computed index. With `repeat=track` the same asset is inserted
   twice (two `AVPlayerItem`s over the same `AVURLAsset`), not downloaded twice.
5. **`MPNowPlayingInfoCenter` does not update itself**: position is refreshed on state
   changes and every 0.5 s while the app is visible. In the background iOS extrapolates
   from the reported `playbackRate`.

## Web / PWA

1. **No guaranteed continuous audio with the screen off.** The browser may freeze the
   page; Media Session handlers do not run then. The fallback exists for desktop/PWA and
   for the Google AI Studio preview.
2. **Wake Lock does not help**: the lock is released automatically when the document
   stops being visible.
3. **A Service Worker does not keep audio alive**: it only caches the shell. Audio
   requests are deliberately not intercepted (`Range`/206).
4. **Autoplay policy**: the first `play()` needs a user gesture; the following ones do
   not, because activation sticks to the document.
5. **`ended` is the only reliable clock**, which is why the web engine relies on it and
   not on `setTimeout`.

## Common

- **JS does not decide the transition.** That is a decision, not a limitation: any
  attempt to "fix" this from JavaScript reintroduces the bug.
- **Events can be lost** if the WebView is frozen. The contract is: events are *UI
  notifications*; the truth is read with `getState()`/`getQueue()` when the app returns
  to the foreground.
- **A single audio session**: the module assumes one player per app. Two simultaneous
  queues would need two services (out of scope).
