/* Service Worker — Thailand-App (13.10.2026, nach Codex-Prüfung Runde 5 überarbeitet)
   - App-Seite: Netz zuerst (immer neueste Fassung, cache:'reload'), nach 4 s oder bei Fehler die gespeicherte.
     Gespeichert wird nur eine Antwort mit Status 200 — in einem festen Seiten-Speicher (thai-app-page).
   - Eigene Dateien (Symbole, Manifest): Speicher zuerst, Versionsspeicher (bei jeder Änderung VERSION hochzählen).
   - Google-Schriften: für offline mitgespeichert (Ausnahme: fremde Antworten sind „undurchsichtig“, Status 0).
   - Karten, Wetter, Suche: nur Netz.
   - Aufräumen nur von eigenen Speichern (Präfix thai-app-), nichts von anderen Seiten derselben Adresse. */
const PREFIX = 'thai-app-';
const VERSION = PREFIX + 'static-v5';
// Schriften schon beim Einrichten mitspeichern (iPhone-Test 13.10.: offline fehlte die Schrift)
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap';
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
    // Schriften: CSS + nur die lateinischen Schriftdateien (latin, latin-ext) vorladen; Fehler hier blockieren nichts
    // Codex-Runde 8: je Datei Zeitlimit + eigener Fehlerfang, damit nichts hängt oder abbricht
    try {
      const fc = await caches.open(FONT_CACHE);
      const cssRes = await Promise.race([fetch(FONT_CSS), timeout(5000)]);
      if (cssRes.status === 200) {
        const css = await cssRes.clone().text();
        await fc.put(FONT_CSS, cssRes);
        const blocks = css.split('/*').slice(1);
        const urls = [];
        for (const b of blocks) {
          const label = b.slice(0, b.indexOf('*/')).trim();
          if (label !== 'latin' && label !== 'latin-ext') continue;
          const m = b.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
          if (m && !urls.includes(m[1])) urls.push(m[1]);
        }
        await Promise.all(urls.map(async u => {
          try {
            const r = await Promise.race([fetch(u, { mode: 'cors' }), timeout(5000)]);
            if (r.status === 200) await fc.put(u, r);
          } catch (e) { /* einzelne Schrift fehlt: egal */ }
        }));
      }
    } catch (e) { /* ohne Netz zum Schriftserver: Standardschrift */ }
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
      // Codex-Runde 9: beide Kopien VOR dem ersten await erzeugen (sonst kann die Antwort schon verbraucht sein)
      const copy1 = response.clone();
      const copy2 = response.clone();
      const save = (async () => {
        try {
          await cache.put('./', copy1);
          await cache.put('./index.html', copy2);
          const clients = await self.clients.matchAll();
          clients.forEach(c => c.postMessage('cached'));
        } catch (e) { /* Speicher voll o. ä.: alte Fassung bleibt */ }
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
        if (res.status === 200 || res.type === 'opaque') {
          try { await fc.put(req, res.clone()); } catch (e) { /* Speicherfehler: Antwort trotzdem liefern */ }
        }
        return res;
      }).catch(() => hit);
      event.waitUntil(net.then(() => {}, () => {}));
      return hit || net;
    })());
  }
  // alles andere (Karten, Wetter, Suche): normal übers Netz
});
