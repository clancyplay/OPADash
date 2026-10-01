/* OPADash PWA — install shell only. Live API/WS stay network-first. */
const CACHE = "opadash-shell-v1";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-180.png",
  "/static/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        PRECACHE.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell / static assets: cache, then network.
  const shell =
    url.pathname === "/" ||
    url.pathname.startsWith("/static/css/") ||
    url.pathname.startsWith("/static/js/") ||
    url.pathname.startsWith("/static/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/static/icons/");

  if (!shell) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        if (url.pathname === "/" || req.mode === "navigate") {
          const home = await cache.match("/");
          if (home) return home;
        }
        throw err;
      }
    })
  );
});
