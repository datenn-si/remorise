// Remorise app-shell service worker.
//
// Strategy: the static shell (HTML, built JS/CSS, icons, manifest)
// is cached so the frontend renders offline. API traffic is never
// cached: requests to /api/ and /health always go to the network.
// Bump SHELL_CACHE when the shell contract changes; activation
// deletes every older cache.
const SHELL_CACHE = 'remorise-shell-v3';
// How long a navigation waits on the network before the cached
// shell takes over. A stopped backend on a tailnet does not refuse
// the connection — packets to the dead peer are simply dropped, so
// an unbounded fetch hangs the launch on the splash screen for as
// long as the OS keeps retransmitting (minutes). The app itself
// polls the backend once it is up, so a short cap only costs a
// possibly one-deploy-stale shell on a very slow network.
const NAVIGATION_TIMEOUT_MS = 3000;
const SHELL_FILES = [
  '/',
  '/index.html',
  '/logo.svg',
  '/manifest.webmanifest',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        await cache.addAll(SHELL_FILES);
        // Precache the built bundles the shell HTML points at, too.
        // They are hashed, so they cannot be listed statically; read
        // them out of the cached index.html. Without this, an install
        // whose first controlled load never finished online leaves a
        // cached shell referencing bundles that were never stored,
        // and an offline launch renders a blank page forever.
        // Best-effort: the runtime cache still fills on the first
        // online visit if anything here fails.
        try {
          const shell = await cache.match('/index.html');
          const html = await shell.text();
          const assets = [
            ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
          ].map((match) => match[1]);
          if (assets.length > 0) await cache.addAll(assets);
        } catch {
          // Keep the install: the shell files above are the contract.
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  if (request.mode === 'navigate') {
    // Pages: network first so a fresh deploy lands; the cached
    // shell takes over when the network is gone OR answers with an
    // error status. A stopped backend behind a proxy still
    // "answers" — with a 502 error page — and fetch does not reject
    // on those, so the status must be checked explicitly, or the
    // proxy's error page replaces the app.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
    event.respondWith(
      fetch(request, { signal: controller.signal })
        .then((response) => {
          clearTimeout(timer);
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
            return response;
          }
          return caches.match('/index.html').then((cached) => cached || response);
        })
        .catch(() => {
          clearTimeout(timer);
          return caches.match('/index.html');
        }),
    );
    return;
  }

  // Static assets (hashed bundles, images, fonts): cache first,
  // and store whatever the network returns for next time. A network
  // failure with nothing cached answers 504 instead of leaving the
  // fetch promise rejected and the load hanging.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => new Response('', { status: 504, statusText: 'Offline' })),
    ),
  );
});
