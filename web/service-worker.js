/**
 * App-shell caching only.
 *
 * Deliberately does NOT intercept audio requests: media elements issue Range
 * requests and a naive cache-first handler breaks seeking (and can serve a
 * truncated body). Preloading audio through the SW is also useless for our
 * problem, because a suspended service worker cannot start a fetch on behalf of a
 * paused page.
 *
 * What a Service Worker cannot do: keep JavaScript running while the page is
 * frozen. Background audio needs the native engines (docs/DECISION.md).
 */
const SHELL_CACHE = 'mediaqueue-shell-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', '../dist/esm/index.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isAudio = /\.(wav|mp3|m4a|aac|ogg|opus|flac)$/i.test(url.pathname);
  if (isAudio || request.headers.has('range')) return; // let the network handle media

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && url.origin === self.location.origin) {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});
