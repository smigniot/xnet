// Service worker — makes Xnet boot even when the relay/server is offline.
// Strategy:
//   * Precache the full app shell + vendored Gun library on install.
//   * Navigations: serve cached index.html (so the SPA always boots).
//   * Same-origin GETs: cache-first, fall back to network, then update cache.
//   * Never touch /gun traffic — Gun manages its own websocket/HTTP transport.

const CACHE = 'xnet-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/app.js',
  '/js/db.js',
  '/js/store.js',
  '/js/crypto.js',
  '/js/markdown.js',
  '/vendor/gun.js',
  '/vendor/sea.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Let Gun's relay traffic go straight to the network.
  if (url.pathname === '/gun' || url.pathname.startsWith('/gun/')) return;
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // SPA navigations always resolve to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
