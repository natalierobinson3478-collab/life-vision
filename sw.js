/* THE PHONE'S OWN COPY (2026-09-01, owner: "an app isn't supposed to break
   like this"). Until today the home-screen icon was a bookmark: every tap
   went out to the internet for the whole 2.4MB board, and a weak signal
   showed nothing at all. This worker is what makes the icon an app. The
   phone keeps a copy of the page and everything it draws with, opens from
   the copy when the network is slow or gone, and takes the newer copy
   quietly whenever the network answers.

   Three rules, one per kind of file:
     · THE PAGE ASKS THE NETWORK FIRST, and waits PAGE_WAIT_MS for it. An
       answer replaces the kept copy and is shown; silence, or an error,
       shows the kept copy. So a phone that is online always sees the latest
       publish, and one that is not still sees a board. The stale-copy
       confusions of the last week came from a page that was cached by
       accident and never refreshed on purpose; this is the refresh, on
       purpose, every open.
     · THE DRAWINGS (assets/, narrator/) are served from the copy at once and
       refreshed behind it, so a companion never waits on a signal.
     · THE VENDOR SCRIPT (supabase-js from the CDN) is kept and served from
       the copy first: it is pinned to a version, so a kept copy is the
       right copy, and without it the board cannot sign in at all.
   Everything else, the account's own API above all, goes straight to the
   network and is never kept: a saved board is never served from a cache.

   This file is only ever registered on the published copy. The workshop at
   localhost:8731 never registers it (the gate is in the page), so a session
   editing the board never sees a copy of it. publish-app.sh stamps VERSION
   with the commit it ships, which is what makes a browser notice a new
   worker and refresh the drawings it keeps. */
const VERSION = "3718b53";
const CACHE = "life-vision-" + VERSION;
const APP = "life-vision-board.html";
const PAGE_WAIT_MS = 4000;

// publish-app.sh refuses to ship if a file under assets/ or narrator/ is
// missing from this list, so a companion added to the folder cannot be
// forgotten by the copy.
const SHELL = [
  APP,
  "assets/app.webmanifest",
  "assets/app-icon-64.png", "assets/app-icon-180.png",
  "assets/app-icon-192.png", "assets/app-icon-512.png", "assets/app-icon.svg",
  "assets/bark-tile.png",
  "narrator/script.json",
  "assets/companions/props/book.svg", "assets/companions/props/keys.svg",
  "assets/companions/props/pages.svg", "assets/companions/props/postcard.svg",
].concat(["cat", "dog", "fox", "moth", "plant", "sparrow"].flatMap(kind =>
  ["acknowledging", "arriving", "idle-full", "idle-young", "idle", "idle2", "resting", "returning"]
    .map(pose => `assets/companions/${kind}/${pose}.svg`)));

const VENDOR = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
];

const scopeUrl = () => new URL(self.registration.scope);
const appUrl = () => new URL(APP, scopeUrl()).href;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // The vendor script comes back opaque (a plain script tag's request has
    // no CORS), which addAll refuses; put() takes it. A CDN that is down at
    // install time must not stop the copy from being kept at all, so this
    // one is tolerated; the fetch rule below picks it up on first use.
    for (const url of VENDOR) {
      try {
        const r = await fetch(new Request(url, { mode: "no-cors" }));
        if (r) await cache.put(url, r);
      } catch (err) {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.indexOf("life-vision-") === 0 && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirstPage(req, e) {
  const cache = await caches.open(CACHE);
  let settled = false;
  const fromNet = fetch(req).then(async (r) => {
    if (r && r.ok) await cache.put(appUrl(), r.clone());
    return r;
  });
  // The fetch keeps running past the wait: a slow answer still refreshes
  // the copy for the next open, so waitUntil holds the worker open for it.
  e.waitUntil(fromNet.catch(() => {}));
  const wait = new Promise(res => setTimeout(() => res(null), PAGE_WAIT_MS));
  try {
    const r = await Promise.race([fromNet.then(x => { settled = true; return x; }), wait]);
    if (r && r.ok) return r;
  } catch (err) {}
  const kept = await cache.match(appUrl(), { ignoreSearch: true });
  if (kept) return kept;
  // Nothing kept yet and no network: let the real answer through, whatever
  // it is, so the browser's own page says so rather than a blank.
  return settled ? fromNet : fromNet.catch(() =>
    new Response("no connection, and no copy of the board on this device yet.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
}

async function copyFirstThenRefresh(req, e) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(req, { ignoreSearch: true });
  const refresh = fetch(req).then(async (r) => {
    if (r && (r.ok || r.type === "opaque")) await cache.put(req, r.clone());
    return r;
  });
  if (kept) { e.waitUntil(refresh.catch(() => {})); return kept; }
  return refresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (VENDOR.indexOf(url.href) !== -1) { e.respondWith(copyFirstThenRefresh(req, e)); return; }
  const scope = scopeUrl();
  if (url.origin !== scope.origin || url.pathname.indexOf(scope.pathname) !== 0) return;
  const isPage = req.mode === "navigate" || url.href.split("?")[0] === appUrl();
  if (isPage) { e.respondWith(networkFirstPage(req, e)); return; }
  e.respondWith(copyFirstThenRefresh(req, e));
});
