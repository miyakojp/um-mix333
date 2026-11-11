// UtaMix service worker: keeps a copy of the app itself so it also works offline.
// It never sends your recordings or projects anywhere.
// v6: network-first — when online, the newest app files are always used, so an update
// shows up immediately (old projects open in the new version too). Offline → cached copy.
const VERSION = 'utamix-v11';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'app.css',
  'app.js', 'audio-engine.js', 'storage.js', 'pitch-editor.js',
  'dsp-core.js', 'dsp-worker.js', 'mix-core.js', 'recorder-worklet.js',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all(FILES.map((f) => fetch(f, { cache: 'reload' }).then((r) => (r.ok ? c.put(f, r) : null)).catch(() => null))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
function fromCache(req) { return caches.match(req, { ignoreSearch: true }); }
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(req, { cache: 'no-cache', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); return res; }
      return (await fromCache(req)) || res;
    } catch (err) {
      const hit = await fromCache(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
