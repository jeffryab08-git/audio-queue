# Design decision (Phase 2)

## 1. Stack: Capacitor 8 plugin (TS + Kotlin + Swift)

The app already exists and is built as a web application (Google AI Studio). There
were three real options:

| Option | Integration cost | Risk | Verdict |
|---|---|---|---|
| Rewrite in React Native | High: new app, new UI | All the web work is thrown away | No |
| Wrap the web app as-is (WebView + `<audio>`) | Zero | **Does not solve it**: the `<audio>` still lives in the WebView | No |
| Capacitor + our own native engine | Low: add a plugin, change ~30 lines in the app | Low and bounded | **Yes** |

Capacitor keeps the web app while moving playback into a native process (Android:
foreground service; iOS: `AVAudioSession` + process with background mode). It is the
only option that satisfies "no rewrite" and "do not depend on JavaScript for the
track change".

## 2. What is reused and what is built

### Reused (open-source dependencies)

| Piece | License | Purpose |
|---|---|---|
| `androidx.media3` (exoplayer, session, datasource, database) 1.8.0 | Apache-2.0 | Playback engine, `MediaSessionService`, `MediaSession`, notification, `SimpleCache`, `CacheWriter`, `DefaultLoadControl` |
| Capacitor 7/8 (`@capacitor/core`, `@capacitor/android`) | MIT | JS↔native bridge, WebView management, permissions |
| Apple `AVFoundation` / `MediaPlayer` (iOS) | system framework | `AVQueuePlayer`, `AVAudioSession`, `MPRemoteCommandCenter`, `MPNowPlayingInfoCenter` |
| Media Session API + Wake Lock (web) | W3C standard | Metadata and controls in the fallback |

### Built from scratch (MIT)

1. **Native queue with a preload window and a JS mirror** — the "what comes next" rule
   exists twice: in the native engine (authority) and in `QueueCore` (mirror for the UI
   and the web fallback). No existing implementation kept both in sync with the same
   `repeat` semantics.
2. **Explicit next-track preload into cache** (`TrackPreloader` with `CacheWriter` +
   backoff retries). Media3 buffers *forward* but does not guarantee the next item is
   downloaded before the transition.
3. **Transition retries that do not kill playback** (`onPlayerError` with re-`prepare()`
   and, once attempts are exhausted, skipping to the next item).
4. **`DynamicHttpDataSourceFactory`** — inject headers (signed URLs) without rebuilding
   the player or invalidating the cache.
5. **Queue persistence** (`QueuePersistence`) to survive process death.
6. **iOS engine with a 2-item window and native repeat** — `AVQueuePlayer` has no
   `repeatMode`; it is implemented by refilling the queue with the index the repeat
   rule computes, so the transition stays native.
7. **Web fallback with two `<audio>` elements** and Media Session, limits documented.
8. **Dependency-free TypeScript bridge** that resolves the backend at runtime
   (`window.Capacitor.Plugins.MediaQueue`), so the same bundle runs in a browser, in
   the Google AI Studio preview and in the installed app.

### Deliberately rejected

- **`react-native-track-player`**: React Native project (does not apply) and its current
  line (v5) is commercially licensed; v4 is still Apache-2.0 but is no longer the main
  line.
- **`@capgo/capacitor-native-audio`** (MPL-2.0): would solve much of the case and is a
  valid alternative if you prefer not to maintain native code. Rejected here because
  the brief explicitly asks for our own auditable MIT code with control over preload
  and retries; the package also does not expose its buffering policy.
- **Concatenated `MediaSource`/MSE audio**: would give perfect gapless on the web, but
  forces repackaging the audio server-side and adds nothing on native.
- **Wake locks as an anti-Doze strategy**: Doze ignores wake locks; the wake lock is
  used only for CPU/radio while the foreground service is already running.

## 3. The invariant that makes it work

> The track change happens inside the native engine, in a single call
> (`setMediaItems` / `AVQueuePlayer` with 2 items), and no JavaScript callback takes
> part in it.

Everything else (notification, events, UI) is observation. If the WebView is frozen,
the music keeps going; when it thaws, `getState()` returns the truth and the UI
re-syncs.

## 4. Queue diagram

```
JS: setQueue([t0..t4])            JS never touches the transition again
        |
        v
+---------------------------------------------------------------+
| PlaybackService (Android, foreground service)                 |
|                                                               |
|  tracks[]  ---- setMediaItems() ---->  ExoPlayer playlist      |
|                                            |                  |
|                        playback ----------> item N            |
|                                            |                  |
|  TrackPreloader ---- CacheWriter ----> SimpleCache            |
|      (item N+1 complete, while N plays)                       |
|                                            |                  |
|                    end of item N (audio clock, not JS)        |
|                                            v                  |
|                                    ExoPlayer moves to N+1     |
|                                    (data already local)       |
|                                            |                  |
|                    onMediaItemTransition -> trackChanged event |
+---------------------------------------------------------------+

iOS equivalent:
AVQueuePlayer([itemN, itemN+1]) --end--> plays itemN+1 (native)
        |                                        |
        +-- KVO currentItem --> refill() --------+--> MPNowPlayingInfoCenter
```

## 5. Why "2 items" and not "the whole playlist" on iOS

`AVQueuePlayer` prepares every item it is given. With a 50-track playlist that is 50
open assets: memory, connections, and a risk of a late `readyToPlay`. With 2 items the
next one is already `readyToPlay` when the current one ends, and the refill happens
while the current track plays. On Android the whole playlist lives in the `Player` (it
is free: `MediaItem`s, not bytes) and the byte-level preload is `TrackPreloader`'s job.
