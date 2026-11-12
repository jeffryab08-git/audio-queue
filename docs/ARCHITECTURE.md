# Arquitectura

## Capas

```
        tu app (web, Google AI Studio, React, Vue, vanilla…)
                              |
                     import { createMediaQueue }
                              |
                    +---------+----------+
                    |   src/index.ts     |   resuelve backend en runtime
                    +----+----------+----+
                         |          |
        NativeMediaQueue |          | WebMediaQueue
     (window.Capacitor)  |          | (HTMLAudio x2 + Media Session)
                         |          |
        +----------------+--+       +--> funciona en navegador / preview
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

## Contrato de datos

`Track` y `PlaybackState` están definidos una vez en `src/definitions.ts` y
replicados en `Track.kt`, `Track.swift`. Los eventos (`trackChanged`,
`stateChanged`, `queueChanged`, `error`, `progress`) llevan el mismo payload en las
tres plataformas.

## Android: quién hace qué

| Responsabilidad | Dónde |
|---|---|
| Poseer la cola y el player | `PlaybackService` (foreground service) |
| Notificación + MediaSession | `MediaSessionService` + `DefaultMediaNotificationProvider` |
| Audio focus | `ExoPlayer.Builder.setAudioAttributes(attrs, handleAudioFocus = true)` |
| Pausa al desconectar auriculares | `setHandleAudioBecomingNoisy(true)` |
| Wake lock / Wi-Fi lock | `setWakeMode(C.WAKE_MODE_NETWORK)` |
| Precarga del siguiente | `TrackPreloader` → `CacheWriter` → `SimpleCache` |
| Reintentos | `Player.Listener.onPlayerError` + backoff |
| Persistencia | `QueuePersistence` (SharedPreferences) |
| Puente JS | `MediaQueuePlugin` (valida y delega, no decide nada) |

`PlaybackHub` es solo fontanería: guarda la instancia del servicio y encola comandos
que lleguen antes de que el servicio exista (creación asíncrona). Así
`setQueue()` llamado en el arranque de la app no se pierde.

## iOS: quién hace qué

| Responsabilidad | Dónde |
|---|---|
| Cola y transición | `AVQueuePlayer` (ventana de 2 items) |
| Refill | KVO sobre `currentItem` → `refill()` |
| Sesión de audio | `AVAudioSession` categoría `.playback` |
| Interrupciones (llamadas) | `AVAudioSession.interruptionNotification` + `shouldResume` |
| Auriculares desconectados | `routeChangeNotification` (`oldDeviceUnavailable`) |
| Lock screen | `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` |
| Repetición | `nextIndex(after:)` en `QueuePlayerEngine` |
| Errores | KVO `status` + `failedToPlayToEndTimeNotification` |

## Web: qué sí y qué no

El fallback usa dos elementos `<audio>`: mientras uno suena, el otro tiene el
siguiente track en `preload="auto"`. Al llegar `ended`, el cambio es un `play()`
sobre un elemento ya buffereado (sin round trip de red). La Media Session publica
metadata y controles.

Lo que no puede hacer: sobrevivir a la congelación de la página. Se documenta en
`docs/LIMITATIONS.md` y se refleja en la UI del demo (`wake lock: liberado`).

## Flujo de estados (nativo)

```
IDLE --setQueue--> BUFFERING --ready--> READY --play--> PLAYING
                                              |            |
                                    (fin de item, motor)   |
                                              v            v
                                         siguiente item  PAUSED
                                              |
                                    (último item y repeat off)
                                              v
                                           ENDED -> PAUSED
```
