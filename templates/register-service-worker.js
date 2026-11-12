/**
 * Snippet para registrar el Service Worker del fallback web.
 *
 * Copia este código a tu index.html (dentro de un <script> al final del <body>)
 * o a tu archivo main.js / app entry point.
 *
 * Solo tiene efecto en el fallback web (browser / PWA). Dentro de Capacitor
 * (Android/iOS instalable) el Service Worker no se usa: la reproducción la
 * hace el motor nativo (Media3 / AVQueuePlayer).
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => {
        console.log('[PWA] Service Worker registrado:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] No se pudo registrar el Service Worker:', err);
      });
  });
}
