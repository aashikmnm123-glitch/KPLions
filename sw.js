/* Baitul Maal — service worker.
 *
 * BUG THIS VERSION FIXES (iOS home-screen app breaking after a while):
 * the old fetch handler treated only `mode === "navigate"` as a page load.
 * On iOS, a request from a home-screen icon frequently is NOT tagged that
 * way, so it fell through to a cache-first branch that never revalidated —
 * the phone kept serving an old build of the app forever, which then
 * failed against an updated database.
 *
 * Now: the HTML document is ALWAYS network-first (fresh app, every launch,
 * with cache only as an offline fallback), and every cached asset is
 * revalidated in the background. Only genuinely static assets are served
 * from cache first.
 *
 * BUMP CACHE_VERSION on every deploy.
 */
const V = "kplions-v1-00";

const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icon-v3-192.png", "./icon-v3-512.png", "./apple-touch-icon-v3.png",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js",
  "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(SHELL.map(u =>
      c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Lets the page tell a waiting worker to take over immediately.
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

const isDoc = (req) =>
  req.mode === "navigate" ||
  req.destination === "document" ||
  (req.headers.get("accept") || "").includes("text/html");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache live data or the auth endpoints.
  if (/supabase\.co|supabase\.in|esm\.sh/.test(url.hostname)) return;

  // ---- HTML: always network-first, cache only as offline fallback ----
  if (isDoc(req)) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const c = await caches.open(V);
        c.put("./index.html", fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match("./index.html")) ||
               new Response("<h1>Offline</h1><p>Reconnect and reopen the app.</p>",
                            { headers: { "Content-Type": "text/html" } });
      }
    })());
    return;
  }

  // ---- Assets: serve cache fast, refresh in the background ----
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.status === 200) caches.open(V).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});


/* =====================================================================
 * PUSH NOTIFICATIONS
 * Fires only if a server actually sends a push (see the Supabase Edge
 * Function). Without that, the app still shows in-app popups and badges;
 * it simply cannot wake a closed phone, because a static site has nothing
 * running to send from.
 * ================================================================== */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Baitul Maal" }; }
  const title = d.title || "Baitul Maal";
  const opts = {
    body: d.body || "",
    icon: "./icon-v3-192.png",
    badge: "./icon-v3-192.png",
    tag: d.tag || ("bm-" + Date.now()),   // distinct tag = separate, individually dismissible
    renotify: true,
    vibrate: [80, 40, 80],
    silent: false,
    data: { tab: d.tab || "over", id: d.id || null, link: d.link || null, url: d.url || "./index.html" },
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // App-icon badge where the platform supports it.
    if (typeof d.badge_count === "number" && self.navigator && "setAppBadge" in self.navigator) {
      try { d.badge_count > 0 ? await self.navigator.setAppBadge(d.badge_count)
                              : await self.navigator.clearAppBadge(); } catch (_) {}
    }
  })());
});

// Tapping a notification deep-links to the right tab.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const target = new URL(data.url || "./index.html", self.location.origin);
  if (data.tab) target.hash = "#tab=" + data.tab;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.location.origin)) {
        await w.focus();
        w.postMessage({ type: "open-tab", tab: data.tab, id: data.id, link: data.link });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
