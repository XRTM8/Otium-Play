/* Krmzi Pro service worker - app shell + API stale-while-revalidate */
'use strict';

const VERSION = '1.4.0';
const SHELL_CACHE = `krmzi-shell-v${VERSION}`;
const STATIC_CACHE = `krmzi-static-v${VERSION}`;
const API_CACHE = `krmzi-api-v${VERSION}`;
const MAX_API_ENTRIES = 80;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css?v=1.4.0',
  './app.js?v=1.4.0',
  './manifest.json',
  './providers/cinemana.js',
  './device-ui.js',
  './catalogue.js',
  './vendor/hls/hls.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './fonts/tajawal.css',
  './fonts/tajawal-1.woff2',
  './fonts/tajawal-2.woff2',
  './fonts/tajawal-3.woff2',
  './fonts/tajawal-4.woff2',
  './fonts/tajawal-5.woff2',
  './fonts/tajawal-6.woff2',
  './fonts/tajawal-7.woff2',
  './fonts/tajawal-8.woff2',
  './fonts/tajawal-9.woff2',
  './fonts/tajawal-10.woff2',
  './vendor/fontawesome/css/all.min.css',
  './vendor/fontawesome/webfonts/fa-solid-900.woff2',
  './vendor/fontawesome/webfonts/fa-regular-400.woff2',
];

/* API responses that are safe to cache briefly. Stream URLs expire, so the
   player endpoint is deliberately never cached. */
const API_CACHEABLE = [/^\/api\/home\b/, /^\/api\/episodes\b/, /^\/api\/series\b/, /^\/api\/search\b/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        SHELL_ASSETS.map(async (asset) => {
          try {
            const response = await fetch(new Request(asset, { cache: 'reload' }));
            if (response && response.ok) await cache.put(asset, response);
          } catch (_) {
            /* A missing optional asset must not break installation. */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE, API_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('krmzi-') && !keep.has(key)).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApiRequest(url) {
  return isSameOrigin(url) && url.pathname.startsWith('/api/');
}

function isCacheableApi(url) {
  return API_CACHEABLE.some((pattern) => pattern.test(url.pathname));
}

function isStaticAsset(url) {
  if (!isSameOrigin(url)) return false;
  return /\.(?:css|js|woff2?|ttf|png|jpe?g|webp|svg|ico|json)$/i.test(url.pathname);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
        await trimCache(cacheName, MAX_API_ENTRIES);
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(network.then(() => {}));

  if (cached) {
    return cached;
  }

  const response = await network;
  if (response) return response;

  return new Response(
    JSON.stringify({ error: 'offline', message: 'تعذر الاتصال بالشبكة. حاول مرة أخرى.' }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    }
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const shell = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(request)) || (await shell.match(request));
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('./index.html', response.clone());
    }
    return response;
  } catch (_) {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match(request)) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      new Response('<!doctype html><meta charset="utf-8"><title>غير متصل</title><p style="font-family:sans-serif;padding:24px">لا يوجد اتصال بالإنترنت.</p>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (!isSameOrigin(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isApiRequest(url)) {
    if (!isCacheableApi(url)) return;
    event.respondWith(staleWhileRevalidate(request, API_CACHE, event));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE).catch(() => fetch(request)));
  }
});
