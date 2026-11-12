# Investigación: por qué la siguiente canción no arranca con la pantalla apagada

Documento de la Fase 1. Todas las afirmaciones sobre plataformas están ancladas a
documentación oficial (ver `docs/SOURCES.md` para el listado completo).

## 1. El síntoma, reformulado

La app reproduce el track actual sin problemas con la pantalla bloqueada, pero el
**track siguiente** no arranca (buffering infinito, corte a los pocos segundos, o
silencio) y **sí arranca en el instante en que se desbloquea**.

Ese "arranca al desbloquear" es la firma de un problema de **ejecución diferida**,
no de red caída ni de URL inválida: la petición que inicia el siguiente track está
en cola, y el sistema la ejecuta cuando la app vuelve a ser visible. Es decir, el
código que decide "qué tocar después" se está ejecutando en un contexto que el OS
tiene derecho a congelar: JavaScript en el WebView.

## 2. Android

### 2.1 Qué hace Doze exactamente

Doze entra cuando el dispositivo está sin cargar, quieto y con la pantalla apagada,
y aplica estas restricciones a las apps:[1]

- Suspende el acceso a red.
- **Ignora los wake locks** (`PowerManager.WakeLock`).
- Difiere las alarmas estándar (`setExact()`, `setWindow()`) a la ventana de mantenimiento.
- No ejecuta `JobScheduler`.
- No permite sync adapters ni escaneos Wi-Fi.

El detalle "ignora los wake locks" es el que más se malinterpreta en foros: **un
partial wake lock no salva a una app en Doze**. No es una herramienta válida para
"resistir Doze"; es una herramienta para que la CPU no se duerma *mientras la app
tiene derecho a ejecutar*.

### 2.2 La excepción que sí existe: foreground service

La tabla de límites por estado de proceso es explícita: para una app **cuyo proceso
corre un foreground service**, la columna de red dice **"No restrictions"**; en
cambio, con la pantalla apagada y Doze activo, una app normal tiene la red
**"Restricted during doze"**.[2]

Es decir: la única forma soportada de que la red siga disponible con la pantalla
apagada es que el proceso esté clasificado como foreground service — y para audio
eso significa `MediaSessionService` con `foregroundServiceType="mediaPlayback"`, que
requiere `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`.[3]

### 2.3 Por qué falla el patrón "JS cambia el src al terminar"

Un `<audio>` dentro de un WebView (o el `AudioPlayer` de una librería manejada desde
JS) resuelve la transición en el hilo de JavaScript:

```js
audio.addEventListener('ended', () => { audio.src = queue[++i].url; audio.play(); });
```

Con la pantalla apagada, el WebView deja de recibir frames y el renderer se congela
o se ralentiza; además, el propio sistema puede posponer el trabajo de red del
proceso si este no es foreground service. Resultado: el evento `ended` llega tarde,
o el `play()` posterior no tiene red/CPU, y la transición queda "pegada". Al
desbloquear, el renderer se reanuda y ejecuta el handler pendiente: exactamente el
síntoma reportado.

Nota importante: aunque el WebView siga "vivo" porque hay audio sonando, la
decisión de *qué* reproducir después sigue dependiendo de un callback de JS que el
OS no tiene obligación de ejecutar a tiempo.

### 2.4 Dónde sí se puede confiar en timers

En ningún lado. `setTimeout`/`setInterval` en background están sujetos a
throttling y a la congelación del renderer. La conclusión de diseño es que **el
cambio de pista no debe depender de ningún timer ni de ningún callback de JS**.

## 3. iOS

### 3.1 Lo que habilita el audio en background

`AVAudioSession.Category.playback` documenta que el audio continúa con el
interruptor de silencio activado y cuando la pantalla se bloquea, y que para seguir
reproduciendo cuando la app pasa a background hay que añadir `audio` a
`UIBackgroundModes` en el `Info.plist`.[5]

Con esa combinación, iOS **no suspende** el proceso mientras haya una sesión de
audio activa reproduciendo. Eso explica por qué el track actual sigue sonando.

### 3.2 Por qué el siguiente no arranca

`AVQueuePlayer` está pensado precisamente para esto: gestiona una cola de
`AVPlayerItem` y avanza solo.[6] El problema aparece cuando la app **no** usa una
cola nativa y en su lugar hace lo mismo que en la web: escucha el final del item y
sustituye el asset desde código de la app. Si esa sustitución ocurre en el hilo de
la WebView (Capacitor/Cordova) o en un callback que iOS decide no ejecutar mientras
el dispositivo está bloqueado, la reproducción se queda sin siguiente item.

Segundo modo de fallo, específico de iOS: si el `AVPlayer` queda sin items
encolados cuando el actual termina, la sesión de audio se queda "sin audio",
iOS puede desactivar la sesión y suspender el proceso — y ya no hay nadie que
cargue el siguiente track.

### 3.3 Diferencia clave Android vs iOS

- **Android**: el riesgo es la red (Doze) y el renderer (WebView). Se resuelve con
  foreground service + cola nativa.
- **iOS**: la red no se corta mientras la sesión de audio está activa; el riesgo es
  quedarse **sin items en la cola** y que la lógica de "siguiente" viva en un
  contexto que puede no ejecutarse. Se resuelve con `AVQueuePlayer` + ventana de 2
  items mantenida por código nativo.

## 4. Web / PWA

- **Media Session API** permite publicar metadata y manejar play/pause/next desde la
  notificación y la pantalla de bloqueo.[7] No otorga permiso de ejecución: si la
  página se congela, los handlers no corren.
- **Screen Wake Lock API** mantiene la pantalla encendida, pero el candado se libera
  cuando el documento deja de estar visible;[8] no sirve para audio en background, y
  además mantener la pantalla encendida es justo lo contrario de lo que se busca.
- **Service Worker**: no puede iniciar reproducción por su cuenta ni mantener viva
  una página congelada. Sirve para cachear el shell y el audio, no para continuidad.
- Conclusión: el fallback web es aceptable en escritorio y en PWA de escritorio, y
  es **estructuralmente incapaz** de garantizar continuidad con la pantalla apagada
  en móvil.

## 5. Soluciones open-source existentes

| Proyecto | Plataforma | Licencia | Estado | ¿Resuelve el caso? |
|---|---|---|---|---|
| `react-native-track-player` v4.1.2 | RN (Android/iOS) | Apache-2.0[10] | mantenimiento activo (v4 en rama `v4`) | Sí: cola nativa, foreground service, controles. **Ojo: v5 pasó a licencia comercial**[9] |
| `expo-audio` 58.x (`AudioPlaylist`) | Expo/RN | MIT | mantenimiento activo | Parcial/sí: playlist nativa + precarga; en Android exige `setActiveForLockScreen` o el audio se corta a los ~3 min[11] |
| `@capgo/capacitor-native-audio` | Capacitor 7/8 | MPL-2.0[12] | muy activo (commits diarios) | Sí: `setQueue()`, skip desde lock screen, background, HLS |
| `@mediagrid/capacitor-native-audio` | Capacitor 7/8 | MIT[13] | activo | Parcial: reproduce en background con notificación, pero la API es de un solo asset (`changeAudioSource`), no de cola |
| Media3 `MediaSessionService` | Android nativo | Apache-2.0[14] | mantenimiento de Google | Es el motor, no la solución completa: hay que escribir servicio, cola y precarga |
| `AVQueuePlayer` | iOS nativo | framework del sistema | — | Es el motor, no la solución completa |

## 6. Veredicto de Hermes

1. **El problema no es Doze en sí.** Doze es el contexto; el bug es de arquitectura:
   la transición de pista vive en JavaScript.
2. **Sí existen soluciones listas.** La más directa para una app ya montada en web es
   `@capgo/capacitor-native-audio` (MPL-2.0, `setQueue()` nativo). Si el proyecto es
   React Native, `react-native-track-player` v4 (Apache-2.0) resuelve lo mismo.
3. **Lo que no existe tal cual** es una pieza que cumpla *todos* los requisitos del
   encargo con licencia MIT y código auditable: cola nativa + precarga explícita del
   siguiente track en caché + reintentos con backoff + cola dinámica + fallback web
   en un solo paquete. Eso es lo que se construyó aquí.
4. **La combinación recomendada** es: motor nativo dueño de la cola (Media3 /
   AVQueuePlayer) + precarga del siguiente item + foreground service / background
   mode + notificación de media; JS solo como mando a distancia de la UI.
