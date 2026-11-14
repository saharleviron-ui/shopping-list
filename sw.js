// Service worker: האפליקציה נפתחת גם בלי קליטה. קריאות ל-GitHub API לא נשמרות במטמון.
const CACHE = 'shopping-list-v8';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'pdf.js', 'products.json', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/karantina-hebrew-700-normal.woff2', 'fonts/karantina-latin-700-normal.woff2', 'fonts/rubik-hebrew-400-normal.woff2', 'fonts/rubik-latin-400-normal.woff2', 'fonts/rubik-hebrew-500-normal.woff2', 'fonts/rubik-latin-500-normal.woff2', 'fonts/rubik-hebrew-600-normal.woff2', 'fonts/rubik-latin-600-normal.woff2', 'fonts/rubik-hebrew-700-normal.woff2', 'fonts/rubik-latin-700-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname === 'api.github.com') return;
  // network first, fallback to cache
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && (url.origin === location.origin || url.hostname.includes('fonts.g'))) {
        const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
