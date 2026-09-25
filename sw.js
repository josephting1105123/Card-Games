/**
 * Service worker: cache the whole app on install so it runs with no network.
 *
 * Strategy is cache-first for everything in PRECACHE, because these files only
 * change when a new CACHE version ships. Navigations fall back to the cached
 * index.html so a deep link still opens offline. Anything else (the /lan
 * WebSocket, /api/info) is left alone.
 *
 * CACHE carries a hash of everything in PRECACHE, written by
 * tools/stamp-sw.mjs and checked by the test suite. It must change whenever a
 * shipped file does, or a returning visitor is served the old app for ever: the
 * browser only installs a new worker when sw.js itself differs. Do not edit the
 * stamp by hand.
 */

const CACHE = 'card-games-75d20f1aad0f';

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './styles/table.css',
  './styles/blackjack.css',
  './src/main.js',
  './src/core/cards.js',
  './src/core/currency.js',
  './src/core/economy.js',
  './src/core/elo.js',
  './src/core/profile.js',
  './src/core/rng.js',
  './src/games/registry.js',
  './src/games/blackjack/american.js',
  './src/games/blackjack/cards.js',
  './src/games/blackjack/malaysian.js',
  './src/games/blackjack/stats.js',
  './src/games/blackjack/tables.js',
  './src/games/doudizhu/ai.js',
  './src/games/doudizhu/engine.js',
  './src/games/doudizhu/match.js',
  './src/games/doudizhu/moves.js',
  './src/games/doudizhu/rules.js',
  './src/net/client.js',
  './src/net/protocol.js',
  './src/net/roomcode.js',
  './src/ui/blackjack.js',
  './src/ui/cardart.js',
  './src/ui/dom.js',
  './src/ui/fullscreen.js',
  './src/ui/lan.js',
  './src/ui/screens.js',
  './src/ui/solo.js',
  './src/ui/tableview.js',
  './assets/fonts/eb-garamond-latin.woff2',
  './assets/fonts/eb-garamond-latin-ext.woff2',
  './assets/fonts/eb-garamond-italic-latin.woff2',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails the whole install if one file 404s, which is the point: a
    // half-cached app that breaks offline is worse than no offline at all.
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/lan') || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
