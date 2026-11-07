/* Service worker — offline support for the teacher attendance page.
   Strategy: network-first for navigations + app shell, stale-while-
   revalidate for static assets, network-first for API.

   R2-E (round 2) root cause of the blank-white reloads: v1 served `/`
   and `/index.html` CACHE-FIRST and never bumped its cache name, so a
   browser that installed the worker before a deploy kept serving a stale
   index.html whose #root was EMPTY (no inline loading fallback) — and
   the stale-while-revalidate JS chunks could 404 once the deploy pruned
   the old hashed assets. React then never mounted: a bare white page
   that only recovered after a second load refreshed the cache. The shell
   must therefore always come from the network when reachable; the cache
   is only an offline fallback. Bump CACHE_NAME on every shell change. */
const CACHE_NAME = 'smp-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls: network first, fall back to cache (GETs only)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request)),
    );
    return;
  }

  // Navigations + app shell: NETWORK FIRST. A stale cached index.html
  // is what blanked the app after deploys, so the cache is only an
  // offline fallback here — never the first thing served.
  if (request.mode === 'navigate' || SHELL.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Other static assets: stale-while-revalidate, caching only
  // successful same-origin responses.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached || network;
    }),
  );
});
