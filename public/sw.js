/* =========================================================================
   Agrima ERP service worker — offline-first shell.
   No Supabase, no CDN: everything the app needs is local.
   Works both at domain root (/) and on GitHub Pages subpaths (/Agrima/)
   by deriving every path from the registration scope.
   ========================================================================= */
const CACHE = 'agrima-v12-local';

const BASE = new URL(self.registration.scope).pathname; // '/' or '/Agrima/' etc.

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll([
        BASE,
        BASE + 'manifest.webmanifest',
        BASE + 'icon.svg',
        BASE + 'vendor/xlsx.full.min.js',
      ]),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // only handle requests under our scope
  if (!url.pathname.startsWith(BASE)) return;

  if (req.mode === 'navigate') {
    // network-first for the shell, fall back to cache offline
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(BASE, copy));
          return res;
        })
        .catch(() => caches.match(BASE).then((r) => r || caches.match(req))),
    );
    return;
  }

  // stale-while-revalidate for same-origin assets
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetching = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetching;
    }),
  );
});
