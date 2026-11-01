// Kwaai's service worker: lets the installed app open Today, the week, the year and Marks without a connection.
// Pages are fetched fresh when online and the last copy is kept for offline; styles and scripts come from the cache
// first. Sign-in, account, moderation, API and calendar requests always go to the network and are never cached.
const VERSION = 'kwaai-v1';
const STATIC = ['/style.css', '/app.js', '/marks-math.js', '/kwaai-icon.svg', '/manifest.webmanifest'];
const OFFLINE_PAGES = ['/today', '/week', '/year', '/marks', '/plan'];
const NEVER = /^\/(login|auth|logout|account|mod|api|cal|week\.ics|takedown)\b/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const offlinePage = () => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · Kwaai</title><link rel="stylesheet" href="/style.css"><main class="wrap" style="padding:40px 20px"><h1 class="page-title">You're offline</h1><p>This page hasn't been saved on your phone yet. Open Today, your week or Marks once while you're online and they'll work offline after that.</p></main>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (STATIC.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  if (req.mode === 'navigate' && OFFLINE_PAGES.includes(url.pathname)) {
    // network first; a good response replaces the saved copy of that page (one per path, whatever the plan link)
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(url.pathname, copy));
      }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || offlinePage())));
    return;
  }
  // any other page: the network, or a friendly offline note instead of the browser's error
  if (req.mode === 'navigate') event.respondWith(fetch(req).catch(() => offlinePage()));
});
