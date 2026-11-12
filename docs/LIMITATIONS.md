# Limitaciones conocidas

## Android

1. **Doze sigue existiendo.** No se elimina: se esquiva por la vía soportada
   (foreground service `mediaPlayback`, que es el único estado de proceso con "No
   restrictions" en red). Si el usuario revoca la notificación (Android 13+) el
   servicio pierde visibilidad y el sistema puede tratarlo peor.
2. **Wake locks no protegen de Doze.** `Doze` ignora los wake locks. El wake lock
   de ExoPlayer (`setWakeMode(C.WAKE_MODE_NETWORK)`) mantiene CPU y radio despiertos
   mientras hay reproducción, pero no es lo que salva la transición: eso lo hace el
   foreground service + la precarga.
3. **Inicio desde background.** En Android 12+ una app no puede arrancar el servicio
   desde background. Todas las llamadas del plugin asumen que la app está en
   foreground (el usuario pulsó play) o que el servicio ya está vivo. Si se invoca
   `play()` desde una notificación push en frío, el comando queda encolado hasta que
   la app vuelva a primer plano.
4. **Cabeceras por track**: se aplican por petición (`DynamicHttpDataSourceFactory`),
   lo que cubre URLs firmadas simples. Tokens que cambian *por rango* (p. ej. firma
   que caduca a mitad de descarga) requieren un `ResolvingDataSource` propio.
5. **Caché y `Content-Length`**: `CacheWriter` necesita saber el tamaño del cuerpo o
   leer hasta EOF. Servidores que no envían `Content-Length` ni aceptan chunked en
   Range pueden dejar la precarga incompleta (no rompe la reproducción, solo la
   optimización).
6. **Persistencia**: se restaura la cola en pausa, nunca en reproducción. Resucitar
   audio sin gesto del usuario es hostil y Android rechazaría el FGS.

## iOS

1. **No compilado en este entorno.** El módulo está escrito contra las APIs públicas
   documentadas, pero este repositorio se construyó/validó en Linux: no hay
   `swiftc`/Xcode disponible. Compilar y ejecutar en un dispositivo real es el paso
   pendiente (ver `docs/TESTING.md`).
2. **Cabeceras HTTP por track no soportadas.** La única vía es
   `AVURLAssetHTTPHeaderFieldsKey`, opción no documentada que arriesga rechazo en
   revisión. Usa tokens en la URL o firmas a nivel de CDN.
3. **Ventana de 2 items**: si el `preferredForwardBufferDuration` (10 s) no alcanza
   para un cambio de red, `automaticallyWaitsToMinimizeStalling = true` hará esperar
   (correcto: mejor una pausa corta que un fallo).
4. **Repetición implementada por relleno**: `AVQueuePlayer` no tiene `repeatMode`; se
   rellena la cola con el índice calculado. Con `repeat=track` el mismo asset se
   inserta dos veces (dos `AVPlayerItem` sobre el mismo `AVURLAsset`), no dos
   descargas.
5. **`MPNowPlayingInfoCenter` no se actualiza solo**: la posición se refresca al
   cambiar de estado y cada 0.5 s mientras la app está visible. En background la
   estimación de iOS sigue el `playbackRate` informado.

## Web / PWA

1. **No hay audio continuo garantizado con la pantalla apagada.** El navegador puede
   congelar la página; los handlers de Media Session no se ejecutan entonces. El
   fallback existe para escritorio/PWA y para el preview de Google AI Studio.
2. **Wake Lock no ayuda**: el candado se libera automáticamente cuando el documento
   deja de estar visible.
3. **Service Worker no mantiene vivo el audio**: solo cachea el shell. Se evita
   interceptar peticiones de audio a propósito (Range/206).
4. **Política de autoplay**: el primer `play()` necesita gesto del usuario; los
   siguientes no, porque la activación queda "pegada" al documento.
5. **`ended` es el único reloj fiable**: por eso el motor web se apoya en él y no en
   `setTimeout`.

## Comunes

- **JS no decide la transición.** Es una decisión, no una limitación: cualquier
  intento de "arreglar" esto desde JavaScript reintroduce el bug.
- **Eventos pueden perderse** si el WebView está congelado. El contrato es: los
  eventos son *notificaciones de UI*; la verdad se lee con `getState()`/`getQueue()`
  al volver a primer plano.
- **Una sola sesión de audio**: el módulo asume un reproductor por app. Dos colas
  simultáneas necesitan dos servicios (fuera de alcance).
