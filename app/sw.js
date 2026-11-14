/* Service worker: funcionamiento sin conexión + recepción de archivos compartidos desde Android. */
const VERSION = 'v6';
const CACHE = `pedidos-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/db.js', 'js/excel.js', 'js/app.js', 'vendor/exceljs.min.js',
  'assets/Plantillas.xlsx', 'assets/inventario_inicial.xlsx',
  'icons/logo.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('pedidos-') && k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Archivo compartido con "Compartir → Pedidos" (Web Share Target)
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('file');
        if (file && file.size) {
          const cache = await caches.open('shared-files');
          await cache.put('shared-file', new Response(file, {
            headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'archivo.xlsx') },
          }));
        }
      } catch (err) { /* se ignora; la app mostrará que no hay archivo */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Caché primero (rápido aunque haya mala señal) y actualización en segundo plano
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(cached => {
    const net = fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => cached || caches.match('index.html'));
    return cached || net;
  }));
});
