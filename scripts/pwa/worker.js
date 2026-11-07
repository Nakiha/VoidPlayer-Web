// The build prepends the revision and exact public URL/integrity pairs.
const cachePrefix = 'voidplayer-offline-';
const cacheName = cachePrefix + revision;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      // addAll commits atomically. A mixed deployment or a truncated download cannot replace a working installation.
      await cache.addAll(Object.entries(assets).map(([url, integrity]) => new Request(url, {
        integrity, credentials: 'omit', redirect: 'error', cache: 'no-cache',
      })));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  // Let old controlled review windows finish before this version takes over.
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName).map(name => caches.delete(name)));
  })());
});

function cached(key) {
  // Only build-verified static bytes are eligible. Compressed and plain representations have identical decoded contents.
  return caches.match(key, { cacheName, ignoreVary: true });
}
function networkFirst(request, fallback) {
  return fetch(request).catch(async error => {
    const hit = await cached(fallback);
    if (!hit) throw error;
    return hit;
  });
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || request.headers.has('range') || request.headers.has('authorization')) return;
  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    // Live deep links, redirects, HTTP errors and temporary bridge credentials must come directly from the server.
    event.respondWith(networkFirst(request, '/index.html'));
    return;
  }
  const key = url.pathname + url.search;
  if (!Object.hasOwn(assets, key) || url.pathname === '/index.html') return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/')) {
    event.respondWith(cached(key).then(hit => hit ?? fetch(request)));
  } else {
    // Public fixed URLs (theme starter, icons) track the online HTML across deployments.
    event.respondWith(networkFirst(request, key));
  }
});
