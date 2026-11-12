# Integración paso a paso

El escenario de partida: una webapp hecha en Google AI Studio que hoy reproduce
audio con `<audio>` y cambia de pista desde JavaScript.

## Paso 0 — Diagnóstico: ¿es tu caso?

Busca en tu código algo como:

```js
audio.addEventListener('ended', () => { playNext(); });
// o
useEffect(() => { if (status.didJustFinish) playNext(); }, [status]);
// o
onEnded={() => setIndex(i => i + 1)}
```

Si el siguiente track se asigna desde JS al terminar el actual, el síntoma con la
pantalla bloqueada es exactamente el descrito. La corrección **no** es un timer ni
un wake lock: es dejar de decidir la transición en JS.

## Paso 1 — Usar el módulo en la web (sin tocar el build)

Copia `dist/esm/` a tu proyecto (o instala el paquete) y sustituye el reproductor:

```js
import { createMediaQueue } from './vendor/index.js';

const queue = createMediaQueue();          // nativo si está disponible, web si no

const tracks = songs.map((s) => ({
  id: s.id,
  url: s.audioUrl,
  title: s.title,
  artist: s.artist,
  album: s.album,
  artwork: s.coverUrl,
}));

// UNA sola llamada: a partir de aquí la cola es del motor
await queue.setQueue(tracks, { startIndex: 0, autoplay: false });

// Controles
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

Elimina el handler de `ended` y todo lo que llame a `playNext()` desde JS. Si
duplicas eventos (`ended` + `trackChanged`), tendrás saltos dobles.

### Reanudar la UI al volver a primer plano

Con la pantalla bloqueada el WebView puede estar congelado y perder eventos. Al
volver:

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

## Paso 2 — Convertirla en app instalable con Capacitor

Si tu app ya está exportada como webapp estática (carpeta `dist/` o `www/`):

```bash
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "Mi App" com.miempresa.app --web-dir=www
npm i capacitor-media-queue          # o "file:../audio-queue" mientras desarrollas
npx cap add android
npx cap add ios
npx cap sync
```

`npx cap sync` detecta el plugin por el bloque `capacitor` de su `package.json` y
genera `android/capacitor.settings.gradle` apuntando al módulo. No hay que editar
Gradle a mano.

### Android

El `AndroidManifest.xml` del plugin ya declara permisos y el servicio; el merge de
manifiestos de Gradle lo incorpora. Solo hay que asegurarse de:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```
y pedir el permiso en runtime (el plugin lo hace):

```js
const { granted } = await queue.requestNotificationPermission();
```

Si tu `targetSdk >= 34`, el servicio debe llevar `foregroundServiceType="mediaPlayback"`
(ya está en el manifest del plugin).

### iOS

1. `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

2. En Xcode: *Signing & Capabilities* → **+ Capability** → *Background Modes* →
   marca *Audio, AirPlay, and Picture in Picture*.
3. `npx cap sync ios` y `pod install` (Capacitor 7) o resolución SPM (Capacitor 8).

## Paso 3 — Verificar en dispositivo

```bash
npx cap run android          # o abrir en Android Studio
```

Prueba de aceptación:

1. Playlist de ≥ 5 tracks.
2. Play, luego bloquear con el botón de encendido.
3. Escuchar: cada ~N segundos debe entrar el siguiente track sin tocar el teléfono.
4. Bajar la notificación: debe mostrar título/artista y responder a
   play/pausa/siguiente.
5. Llamar al teléfono: el audio pausa; al colgar, retoma.

En logcat (Android) puedes seguir el rastro del demo:

```bash
adb logcat | grep -E "MediaQueueDemo|ExoPlayerImplInternal"
```

## Notas de integración

- **No instancies dos motores.** `createMediaQueue()` debe llamarse una vez y
  compartirse (context/store/module singleton). Dos instancias en web crean cuatro
  `<audio>`.
- **No reordenes la cola a mano en tu estado.** Usa `addToQueue`, `insertAt`,
  `removeAt`, `move`: el motor nativo y tu UI se mantienen alineados.
- **IDs estables.** `Track.id` se usa como clave de caché; si cambia entre sesiones,
  se descarga dos veces.
- **URLs accesibles desde el dispositivo.** `localhost` en el móvil no es tu portátil.
  Para pruebas usa `http://10.0.2.2:8099/` (emulador Android) o la IP de tu equipo.
- **CORS**: en nativo no aplica (la petición la hace ExoPlayer/AVFoundation, no el
  navegador); en el fallback web sí, y el servidor debe permitir `Range` y exponer
  `Accept-Ranges`.
- **Si ya usas `@capgo/capacitor-native-audio`** y te basta su API de cola, puedes
  quedarte con él: este módulo existe para tener control del preload, los reintentos
  y la licencia MIT, no porque aquel no funcione.

## Migración desde el patrón actual (diff conceptual)

```diff
- audio.src = tracks[index].url;
- audio.play();
+ await queue.setQueue(tracks, { startIndex: index, autoplay: true });

- audio.addEventListener('ended', () => {
-   index += 1;
-   audio.src = tracks[index].url;   // se congela en background
-   audio.play();
- });
+ // nada: el motor nativo avanza solo. La UI se entera por trackChanged.

- setInterval(updateProgress, 250);   // throttled en background
+ queue.addListener('progress', updateProgress);   // solo para la UI
```
