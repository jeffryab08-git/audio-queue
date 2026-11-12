# Plantillas de configuración para tu app

Estos archivos NO son parte del plugin. Son **plantillas** para que copies y adaptes
en **tu app** (la que construiste en Google AI Studio) cuando la conviertas en app
instalable con Capacitor.

## Qué hay aquí

| Archivo | Para qué sirve | Dónde va en tu app |
|---|---|---|
| `capacitor.config.json` | Configuración central de Capacitor (appId, nombre, webDir) | Raíz de tu proyecto |
| `package.app.json` | Dependencias que tu app necesita (Capacitor + el plugin) | Renómbralo a `package.json` o fusiónalo con el tuyo |
| `android-gradle.properties` | Settings Gradle a nivel proyecto (Android) | `android/gradle.properties` |
| `android-variables.gradle` | Versiones de SDK y AndroidX (Android) | `android/variables.gradle` |
| `android-app-build.gradle` | Build config del módulo app (Android) | `android/app/build.gradle` |
| `android-app-AndroidManifest.xml` | Manifest de la app (Android). El manifest del plugin se fusiona automáticamente | `android/app/src/main/AndroidManifest.xml` |
| `ios-Info.plist` | Snippet de Info.plist con `UIBackgroundModes: audio` (iOS) | Fusiona con tu `ios/App/App/Info.plist` |
| `register-service-worker.js` | Snippet para registrar el SW del fallback web | Tu `index.html` o `main.js` |

## Flujo de uso

1. Ya refactorizaste tu app web para usar `createMediaQueue()` (ver
   `docs/INTEGRATION.md`).
2. Empaqueta tu web app como static (`dist/` o `www/`).
3. Copia `capacitor.config.json` y `package.app.json` a la raíz de tu proyecto
   (ajusta `appId`, `appName`, `webDir`).
4. Instala dependencias:
   ```bash
   npm install
   npx cap add android
   npx cap add ios
   npx cap sync
   ```
5. `npx cap sync` genera automáticamente varios archivos en `android/` e `ios/`:
   - `android/capacitor.settings.gradle`
   - `android/app/capacitor.build.gradle`
   - `android/app/src/main/assets/capacitor.config.json`
   - `android/app/src/main/assets/capacitor.plugins.json`
   - `ios/App/App/capacitor.config.json`
   No tienes que crear esos: se regeneran en cada `cap sync`.

6. Verifica que las plantillas de Android coincidan con lo que generó `cap sync`
   (en general sí; las plantillas aquí son las versiones mínimas compatibles
   con el plugin). Si hay conflicto, prefiere las versiones de `cap sync` y solo
   añade los extras indicados en los comentarios.

7. **iOS obligatorio**: fusiona `ios-Info.plist` con tu
   `ios/App/App/Info.plist` (necesitas `UIBackgroundModes: audio` para que el
   audio continúe con la pantalla bloqueada).

8. **iOS obligatorio**: en Xcode → Signing & Capabilities → + Capability →
   Background Modes → marca "Audio, AirPlay, and Picture in Picture".

9. Compila y prueba en dispositivo real:
   ```bash
   npx cap open android     # abre Android Studio
   npx cap open ios         # abre Xcode (requiere Mac)
   ```

## Versiones compatibles (verificadas)

| Componente | Versión |
|---|---|
| Capacitor | 7.x (compileSdk 35, CocoaPods) y 8.x (compileSdk 36, SPM) |
| Media3 (Android) | 1.8.0 (1.9+ requiere compileSdk 36) |
| Android minSdk | 23 (plugin) / 24+ recomendado |
| iOS | 14+ |
| Kotlin | 2.1.0 |
| Java | 17 |

Estas versiones están ya fijadas en `android-variables.gradle` y en
`android/build.gradle` del plugin. No las cambies salvo que sepas lo que haces.

## Notas importantes

- **No declares permisos del plugin en tu AndroidManifest**. El manifest del
  plugin (`android/src/main/AndroidManifest.xml`) ya declara
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`,
  `POST_NOTIFICATIONS`, `INTERNET`, `ACCESS_NETWORK_STATE` y el
  `MediaSessionService`. Gradle lo fusiona automáticamente con el de tu app.

- **El `package.app.json` es una plantilla mínima**. Si tu app ya tiene un
  `package.json` (lo normal), NO lo reemplaces: solo añade las dependencias
  que falten (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`,
  `@capacitor/ios`, `capacitor-media-queue`).

- **iOS no soporta headers por track**. Si tus URLs de audio requieren auth,
  pon el token en la URL o firma a nivel CDN. En Android sí funciona con
  `setQueue(tracks, { headers: {...} })`.

- **Para URLs alcanzables desde el dispositivo**: `localhost` en el móvil no es
  tu laptop. Usa `http://10.0.2.2:8099/` (emulador Android) o la IP de tu
  máquina en la red local.
