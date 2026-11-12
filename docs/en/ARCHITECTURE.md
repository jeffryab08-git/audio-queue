# Architecture

## Layers

```
        your app (web, Google AI Studio, React, Vue, vanilla…)
                              |
                     import { createMediaQueue }
                              |
                    +---------+----------+
                    |   src/index.ts     |   resolves the backend at runtime
                    +----+----------+----+
                         |          |
        NativeMediaQueue |          | WebMediaQueue
     (window.Capacitor)  |          | (2x HTMLAudio + Media Session)
                         |          |
        +----------------+--+       +--> works in the browser / preview
        |                   |
   Android (Kotlin)     iOS (Swift)
   MediaQueuePlugin     MediaQueuePlugin
        |                   |
   PlaybackService      QueuePlayerEngine
   (MediaSessionService) (AVQueuePlayer)
        |                   |
   ExoPlayer + SimpleCache  AVPlayerItem x2
   TrackPreloader           MPRemoteCommandCenter
```

## Data contract

`Track` and `PlaybackState` are defined once in `src/definitions.ts` and mirrored in
`Track.kt` and `Track.swift`. The events (`trackChanged`, `stateChanged`,
`queueChanged`, `error`, `progress`) carry the same payload on all three platforms.

## Android: who does what

| Responsibility | Where |
|---|---|
| Owns the queue and the player | `PlaybackService` (foreground service) |
| Notification + MediaSession | `MediaSessionService` + `DefaultMediaNotificationProvider` |
| Audio focus | `ExoPlayer.Builder.setAudioAttributes(attrs, handleAudioFocus = true)` |
| Pause on headphone unplug | `setHandleAudioBecomingNoisy(true)` |
| Wake lock / Wi-Fi lock | `setWakeMode(C.WAKE_MODE_NETWORK)` |
| Next-track preload | `TrackPreloader` → `CacheWriter` → `SimpleCache` |
| Retries | `Player.Listener.onPlayerError` + backoff |
| Persistence | `QueuePersistence` (SharedPreferences) |
| JS bridge | `MediaQueuePlugin` (validates and delegates; decides nothing) |

`PlaybackHub` is plumbing only: it holds the service instance and queues commands that
arrive before the service exists (asynchronous creation), so a `setQueue()` call made
during app startup is not lost.

## iOS: who does what

| Responsibility | Where |
|---|---|
| Queue and transition | `AVQueuePlayer` (2-item window) |
| Refill | KVO on `currentItem` → `refill()` |
| Audio session | `AVAudioSession` category `.playback` |
| Interruptions (calls) | `AVAudioSession.interruptionNotification` + `shouldResume` |
| Headphones unplugged | `routeChangeNotification` (`oldDeviceUnavailable`) |
| Lock screen | `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` |
| Repeat | `nextIndex(after:)` in `QueuePlayerEngine` |
| Errors | `status` KVO + `failedToPlayToEndTimeNotification` |

## Web: what it can and cannot do

The fallback uses two `<audio>` elements: while one plays, the other holds the next
track with `preload="auto"`. When `ended` fires, the switch is a `play()` on an
already-buffered element (no network round trip). Media Session publishes metadata and
controls.

What it cannot do: survive the page being frozen. This is documented in
`docs/en/LIMITATIONS.md` and reflected in the demo UI (`wake lock: released`).

## State flow (native)

```
IDLE --setQueue--> BUFFERING --ready--> READY --play--> PLAYING
                                              |            |
                                    (end of item, engine)  |
                                              v            v
                                         next item      PAUSED
                                              |
                                    (last item and repeat off)
                                              v
                                           ENDED -> PAUSED
```
