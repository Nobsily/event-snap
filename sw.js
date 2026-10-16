/* EventSnap service worker - 圏外でも開けるように画面一式をキャッシュする
 * 画面を更新したら CACHE の版数を上げる（古いキャッシュは自動で消える）
 */
const CACHE = 'event-snap-v0.4.0';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './grok-prompt.txt',
  './gemini-prompt.txt',
  './sample-event.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// キャッシュをすぐ返しつつ、裏で最新版を取りに行く（次回から新しい版になる）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req)
          .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => hit || (req.mode === 'navigate' ? cache.match('./index.html') : undefined));
        return hit || net;
      })
    )
  );
});
