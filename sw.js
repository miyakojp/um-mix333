// UtaMix service worker: caches the app itself so it works offline. It never sends your data anywhere.
const VERSION = 'utamix-v3';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'app.css',
  'app.js', 'audio-engine.js', 'storage.js', 'pitch-editor.js',
  'dsp-core.js', 'dsp-worker.js', 'recorder-worklet.js',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
