# Pruebas: qué se verificó realmente

Todo lo de abajo se ejecutó en este entorno (Linux, JDK 21, Android SDK 36,
emulador `android-34 google_apis x86_64`). Lo que no se pudo ejecutar se dice
explícitamente.

## 1. TypeScript: 25/25 tests verdes

```bash
npm run build          # tsc -p tsconfig.json  (strict, sin errores)
node --test test/      # 25 tests
```

```
ℹ tests 25
ℹ pass 25
ℹ fail 0
```

Cobertura de los tests:

- `test/queue-core.test.mjs` (9): avance automático, `repeat` off/track/queue,
  salto manual sin wrap, `insertAt`/`removeAt`/`move` manteniendo el track actual,
  snapshots inmutables.
- `test/web-engine.test.mjs` (12): la cola de 5 tracks avanza completa **sin
  intervención externa**; el cambio usa el elemento precargado (0 `load()` extra);
  el swap ocurre en < 250 ms (medido, normalmente < 1 ms); `repeat`; reintentos con
  backoff hasta error fatal; rechazo de `play()` reportado como `PERMISSION`;
  mutaciones de cola consistentes.
- `test/native-bridge.test.mjs` (4): sin Capacitor → motor web; plataforma web de
  Capacitor (preview de Google AI Studio) → motor web; plataforma nativa → todas las
  llamadas se reenvían con el shape exacto que espera Kotlin/Swift; `addListener` y
  su `unsubscribe` funcionan; `registerPlugin` se usa si `Plugins` no está poblado.

## 2. Android: APK compilado

```bash
cd example/android
JAVA_HOME=~/jdk21 ./gradlew :app:assembleDebug
# BUILD SUCCESSFUL — app/build/outputs/apk/debug/app-debug.apk (8.7 MB)
```

Capacitor 8.6.0, AGP 8.13.0, Gradle 8.14.3, compileSdk 36, Media3 1.8.0,
Kotlin 2.1.0. El plugin se incluye como proyecto Gradle normal
(`capacitor.settings.gradle` lo resuelve desde `../../android`).

Bugs reales encontrados y corregidos durante la compilación:

1. `Player is accessed on the wrong thread` — Capacitor invoca los métodos del
   plugin en su propio `CapacitorPlugins` HandlerThread y ExoPlayer está confinado
   al hilo que lo creó. **Corregido** marshalling todo a `Looper.getMainLooper()`
   (`PlaybackHub.run`/`onMain`). Este crash solo aparece en un dispositivo, no en
   revisión de código.
2. `C.LENGTH_UNSET` es `int` (no `long`) en Media3 → `DataSpec` con `toLong()`.
3. `ExoPlayer.setMediaSourceFactory` no existe en la instancia (solo en el builder)
   → se sustituyó por `DynamicHttpDataSourceFactory`, que aplica cabeceras por
   petición sin reconstruir el player.
4. `play()` después de `STATE_ENDED` no hacía nada → reinicio desde el principio.

## 3. Android en emulador: reproducción con pantalla apagada y Doze forzado

Escenario: 5 tracks WAV de 6 s servidos por HTTP (`python3 -m http.server 8099`),
app instalada, `POST_NOTIFICATIONS` concedido, `adb shell input tap` sobre play.

Prueba A — pantalla apagada + Doze forzado:

```bash
adb shell input keyevent 26                  # apagar pantalla
adb shell dumpsys battery unplug
adb shell dumpsys deviceidle force-idle      # Doze inmediato
adb shell dumpsys power   | grep mWakefulness   # -> Asleep
adb shell dumpsys deviceidle | grep mState      # -> IDLE
```

Transiciones observadas en logcat **con la pantalla apagada y el dispositivo en
Doze IDLE** (track de 6 s):

```
17:07:37.447  trackChanged → #2 Tono C #3 (ended, automatic)
17:07:43.448  trackChanged → #3 Tono D #4 (ended, automatic)
17:07:49.456  trackChanged → #4 Tono E #5 (ended, automatic)
```

Deriva respecto al final teórico del track anterior: **1 ms, 1 ms, 8 ms**. El
criterio de aceptación pedía < 2 s. La reproducción terminó la lista completa sin
desbloquear la pantalla.

Prueba B — controles de media con pantalla apagada:

```bash
adb shell cmd media_session dispatch next    # -> trackChanged → #1 (next)
adb shell cmd media_session dispatch pause
adb shell cmd media_session dispatch play
```

Estado resultante (`dumpsys media_session`):

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

Esto verifica: sesión activa, metadata en la notificación, cola expuesta al sistema,
audio focus con los atributos correctos y media buttons enrutados.

Prueba C — wake lock y precarga:

```
PARTIAL_WAKE_LOCK 'ExoPlayer:WakeLockManager' ACQ=-3s26ms (uid=10192)
adb shell run-as com.hermes.mediaqueue.demo du -sh cache/media-queue-cache
1.3M   cache/media-queue-cache        # 5 tracks precargados/cacheados
```

Los tracks posteriores se reprodujeron **desde caché**, no desde la red: es la razón
por la que Doze no puede romper la transición.

## 4. iOS: NO verificado aquí

No hay toolchain de Swift en este entorno. Lo que sí se hizo:

- Revisión contra la documentación oficial de `AVQueuePlayer`, `AVAudioSession`
  (categoría `.playback` + `UIBackgroundModes: audio`), `MPRemoteCommandCenter` y
  `MPNowPlayingInfoCenter`.
- Confinamiento de todas las mutaciones de cola a `DispatchQueue.main`.
- Configuración de `Package.swift` (Capacitor 8, SPM) y `MediaQueue.podspec`
  (Capacitor 7, CocoaPods).

Checklist para validarlo en un Mac (30 min):

```bash
# 1. app de ejemplo
cd example && npm i && cp -r www android 2>/dev/null
npx cap add ios && npx cap sync ios
# 2. abrir en Xcode, activar "Audio, AirPlay and Picture in Picture" en
#    Signing & Capabilities > Background Modes
# 3. servir los tracks: en example/www/audio -> python3 -m http.server 8099
#    y en la app usar ?base=http://<ip-del-mac>:8099/  (o cambiar defaultBase)
# 4. run en dispositivo, play, bloquear con el botón de encendido
# 5. esperar 5 tracks x 6 s y comprobar en Xcode > Devices > Console:
#    "trackChanged" cada 6 s, y en la pantalla bloqueada el Now Playing avanzando
```

Criterio de éxito iOS: 4 transiciones automáticas con el dispositivo bloqueado y el
siguiente track audible en < 2 s.

## 5. Lo que no se ha probado

| Requisito | Estado |
|---|---|
| Playlist de 5 tracks con pantalla apagada (Android) | **Verificado** |
| Transición < 2 s sin desbloquear | **Verificado (1–8 ms)** |
| Notificación con controles | **Verificado** (`dumpsys media_session`, dispatch) |
| Wake lock durante buffer/reproducción | **Verificado** (`dumpsys power`) |
| Precarga del siguiente track | **Verificado** (1.3 MB en `SimpleCache`) |
| Audio focus / pausa por llamada | Implementado con la API estándar (`handleAudioFocus = true`), **no ejercitado** (el emulador no tiene telefonía) |
| Salida audible por altavoz | **No verificada**: el emulador corrió sin backend de audio del host (`pulseaudio: Failed to initialize PA context`). La verificación fue por estado del motor: `state=PLAYING(3)`, `position` avanzando, transiciones `automatic` y pistas servidas desde `SimpleCache` — prueba de que el pipeline decodifica y avanza, no de que se oiga. Comprobar en dispositivo real |
| iOS completo | **No compilado** (sin Xcode aquí) |
| PWA en móvil real | **No** — por diseño no garantiza continuidad |
