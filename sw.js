/* Service Worker — Thailand-App (13.10.2026, nach Codex-Prüfung Runde 5 überarbeitet)
   - App-Seite: Netz zuerst (immer neueste Fassung, cache:'reload'), nach 4 s oder bei Fehler die gespeicherte.
     Gespeichert wird nur eine Antwort mit Status 200 — in einem festen Seiten-Speicher (thai-app-page).
   - Eigene Dateien (Symbole, Manifest): Speicher zuerst, Versionsspeicher (bei jeder Änderung VERSION hochzählen).
   - Google-Schriften: für offline mitgespeichert (Ausnahme: fremde Antworten sind „undurchsichtig“, Status 0).
   - Karten, Wetter, Suche: nur Netz.
   - Aufräumen nur von eigenen Speichern (Präfix thai-app-), nichts von anderen Seiten derselben Adresse. */
const PREFIX = 'thai-app-';
const VERSION = PREFIX + 'static-v2';
const PAGE_CACHE = PREFIX + 'page';
const FONT_CACHE = PREFIX + 'fonts';
const KEEP = [VERSION, PAGE_CACHE, FONT_CACHE];
const STATIC = ['./manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const stat = await caches.open(VERSION);
    for (const url of STATIC) {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res.status === 200) await stat.put(url, res);
    }
    const page = await fetch(new Request('./', { cache: 'reload' }));
    if (page.status === 200) {
      const pc = await caches.open(PAGE_CACHE);
      await pc.put('./', page.clone());
      await pc.put('./index.html', page);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && !KEEP.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    clients.forEach(c => c.postMessage('cached'));
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function networkFirstPage(event) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await Promise.race([fetch(event.request, { cache: 'reload' }), timeout(4000)]);
    if (response && response.status === 200) {
      const save = (async () => {
        await cache.put('./', response.clone());
        await cache.put('./index.html', response.clone());
        const clients = await self.clients.matchAll();
        clients.forEach(c => c.postMessage('cached'));
      })();
      event.waitUntil(save);
      return response;
    }
    throw new Error('HTTP ' + (response && response.status));
  } catch (e) {
    return (await cache.match('./')) || (await cache.match('./index.html')) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App-Seite selbst
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirstPage(event));
    return;
  }
  // Prüfabruf auf neue Fassung nie aus dem Speicher
  if (url.origin === self.location.origin && url.searchParams.has('check')) return;

  // Eigene Dateien: Speicher zuerst
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const stat = await caches.open(VERSION);
      const hit = await stat.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.status === 200) await stat.put(req, res.clone());
      return res;
    })());
    return;
  }
  // Google-Schriften: für offline mitspeichern (stale-while-revalidate)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const fc = await caches.open(FONT_CACHE);
      const hit = await fc.match(req);
      const net = fetch(req).then(async res => {
        if (res.status === 200 || res.type === 'opaque') await fc.put(req, res.clone());
        return res;
      }).catch(() => hit);
      event.waitUntil(net.then(() => {}, () => {}));
      return hit || net;
    })());
  }
  // alles andere (Karten, Wetter, Suche): normal übers Netz
});
