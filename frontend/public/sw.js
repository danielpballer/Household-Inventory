/**
 * Service worker — app shell caching strategy.
 *
 * On install:  cache index.html (the app shell entry point).
 * On fetch:    for JS/CSS/image assets, try cache first then network,
 *              storing new assets as they're fetched (handles Vite's
 *              hashed filenames without needing to know them upfront).
 *              For navigation requests, try network first and fall back
 *              to the cached shell so the app loads offline.
 *
 * Inventory data is served from IndexedDB (offline.js), not the cache.
 */

const CACHE = 'pantry-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add('/')),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Delete any old cache versions
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigation requests (loading the app): network first, fall back to shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Static assets (JS, CSS, images): cache first, then network
  // New assets are stored on first fetch so hashed filenames are handled automatically
  if (['script', 'style', 'image', 'font'].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
          return response;
        });
      }),
    );
  }
});
