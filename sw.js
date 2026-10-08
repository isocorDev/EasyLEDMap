/* LED Mapper service worker: caches the app so it runs with no network after the first visit. */
const CACHE = 'led-mapper-0.1.0';
const FILES = ['./', 'index.html', 'css/app.css', 'js/geom.js', 'js/model.js', 'js/detect.js', 'js/zip.js', 'js/exporters.js', 'js/app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network first so updates arrive, cache when offline.
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
