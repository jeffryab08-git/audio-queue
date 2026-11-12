# Decisión de diseño (Fase 2)

## 1. Stack: plugin Capacitor 8 (TS + Kotlin + Swift)

La app ya existe y está construida como aplicación web (Google AI Studio). Las tres
opciones reales eran:

| Opción | Coste de integración | Riesgo | Veredicto |
|---|---|---|---|
| Reescritura en React Native | Alto: nueva app, nuevo UI | Se pierde todo el trabajo web | No |
| Envolver la web tal cual (WebView + `<audio>`) | Nulo | **No resuelve el problema**: el `<audio>` sigue viviendo en el WebView | No |
| Capacitor + motor nativo propio | Bajo: se añade un plugin y se cambian ~30 líneas de la app | Bajo y acotado | **Sí** |

Capacitor permite conservar la webapp y, al mismo tiempo, mover la reproducción a
un proceso nativo (Android: foreground service; iOS: `AVAudioSession` + proceso con
background mode). Es la única opción que cumple "no reescribir" y "no depender de
JavaScript para el cambio de pista".

## 2. Qué se reutiliza y qué se construye

### Reutilizado (dependencias open-source)

| Pieza | Licencia | Para qué |
|---|---|---|
| `androidx.media3` (exoplayer, session, datasource, database) 1.8.0 | Apache-2.0 | Motor de reproducción, `MediaSessionService`, `MediaSession`, notificación, `SimpleCache`, `CacheWriter`, `DefaultLoadControl` |
| Capacitor 7/8 (`@capacitor/core`, `@capacitor/android`) | MIT | Puente JS↔nativo, gestión del WebView, permisos |
| Avalon `AVFoundation` / `MediaPlayer` (iOS) | framework del sistema | `AVQueuePlayer`, `AVAudioSession`, `MPRemoteCommandCenter`, `MPNowPlayingInfoCenter` |
| Media Session API + Wake Lock (web) | estándar W3C | Metadata y controles en el fallback |

### Construido desde cero (MIT)

1. **Cola nativa con ventana de precarga y espejo en JS** — la lógica de "qué sigue"
   vive dos veces: en el motor nativo (autoridad) y en `QueueCore` (espejo para la
   UI y para el fallback web). No existía una implementación que mantuviera ambos
   sincronizados con la misma semántica de `repeat`.
2. **Precarga explícita del siguiente track en caché** (`TrackPreloader` con
   `CacheWriter` + reintentos con backoff). Media3 bufferiza *hacia delante* pero no
   garantiza que el siguiente item esté descargado antes de la transición.
3. **Reintentos de transición sin matar la reproducción** (`onPlayerError` con
   re-`prepare()` y, agotados los intentos, salto al siguiente item).
4. **`DynamicHttpDataSourceFactory`** — inyectar cabeceras (URLs firmadas) sin
   reconstruir el player ni invalidar la caché.
5. **Persistencia de cola** (`QueuePersistence`) para sobrevivir muerte de proceso.
6. **Motor iOS con ventana de 2 items + repetición nativa** — `AVQueuePlayer` no
   tiene `repeatMode`; se implementa rellenando la cola con el índice calculado por
   la regla de repetición, de forma que la transición sigue siendo nativa.
7. **Fallback web con doble `<audio>`** y Media Session, con límites documentados.
8. **Puente TypeScript sin dependencias** que resuelve el backend en runtime
   (`window.Capacitor.Plugins.MediaQueue`), de modo que el mismo bundle corre en
   navegador, en preview de Google AI Studio y en la app instalada.

### Descartado a propósito

- **`react-native-track-player`**: proyecto React Native (no aplica) y su versión
  actual (v5) es de licencia comercial; la v4 sigue en Apache-2.0 pero ya no es la
  línea principal.
- **`@capgo/capacitor-native-audio`** (MPL-2.0): resolvería gran parte del caso y es
  una alternativa válida si se prefiere no mantener código nativo. Se descartó aquí
  porque el encargo pide explícitamente código propio, auditable, MIT, con control
  del preload y del reintento; además el paquete no expone la política de buffer.
- **Audio por `MediaSource`/MSE concatenado**: daría gapless perfecto en web, pero
  obliga a reempaquetar el audio en el servidor y no aporta nada en nativo.
- **Wake locks como estrategia anti-Doze**: Doze ignora los wake locks; el wake lock
  se usa solo para el CPU/radio mientras el foreground service ya está activo.

## 3. El invariante que hace que funcione

> El cambio de pista ocurre dentro del motor nativo, en una sola llamada
> (`setMediaItems` / `AVQueuePlayer` con 2 items), y ningún callback de JavaScript
> participa en él.

Todo lo demás (notificación, eventos, UI) es observación. Si el WebView está
congelado, la música sigue; cuando se descongela, `getState()` devuelve la verdad y
la UI se sincroniza.

## 4. Diagrama de la cola

```
JS: setQueue([t0..t4])            JS nunca vuelve a tocar la transición
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
|      (item N+1 completo, mientras suena N)                    |
|                                            |                  |
|                    fin de item N (reloj de audio, no JS)      |
|                                            v                  |
|                                    ExoPlayer pasa a N+1       |
|                                    (datos ya locales)         |
|                                            |                  |
|                    onMediaItemTransition -> evento trackChanged|
+---------------------------------------------------------------+

iOS equivalente:
AVQueuePlayer([itemN, itemN+1]) --fin--> reproduce itemN+1 (nativo)
        |                                        |
        +-- KVO currentItem --> refill() --------+--> MPNowPlayingInfoCenter
```

## 5. Por qué "2 items" y no "toda la playlist" en iOS

`AVQueuePlayer` prepara cada item que se le entrega. Con una playlist de 50 tracks
eso son 50 assets abiertos: memoria, conexiones y riesgo de `readyToPlay` tardío.
Con 2 items el siguiente ya está `readyToPlay` cuando termina el actual, y el
relleno ocurre durante la reproducción del actual. En Android la playlist completa
está en el `Player` (es gratis: son `MediaItem`, no bytes) y la precarga de bytes la
hace `TrackPreloader`.
