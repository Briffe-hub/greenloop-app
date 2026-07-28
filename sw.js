/* GreenLoop — Service Worker
   Cache "app shell" pour l'installation PWA et un chargement rapide.
   Les données (Supabase) ne sont pas mises en cache : toujours en réseau. */
const CACHE = "greenloop-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./lib/supabase.js",
  "./lib/html5-qrcode.min.js",
  "./lib/qrcode.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Stratégie « réseau d'abord » : on récupère toujours la dernière version en
// ligne (les mises à jour arrivent immédiatement), et on retombe sur le cache
// uniquement hors-ligne. Les appels externes (Supabase) ne sont pas interceptés.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
