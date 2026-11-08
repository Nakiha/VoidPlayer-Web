// The build prepends the revision and exact public URL/integrity pairs.
const cachePrefix = 'voidplayer-offline-';
const cacheName = cachePrefix + buildId + '-' + revision;
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
async function retained(key, prefix) {
  for (const name of await caches.keys()) {
    if (!name.startsWith(prefix)) continue;
    const hit = await caches.match(key, { cacheName: name, ignoreVary: true });
    if (hit) return hit;
  }
}
function networkFirst(request, fallback) {
  return fetch(request).catch(async error => {
    const hit = await cached(fallback);
    if (!hit) throw error;
    return hit;
  });
}
async function playerNavigation(request) {
  // An explicit update applies only to this navigation. Sibling review windows retain their worker and cache.
  const target = new URL(request.url).searchParams.get('vp-update');
  if (target && /^[a-f0-9-]{36}$/.test(target)) return fetch(request).catch(async error => {
    const html = await retained('/index.html', cachePrefix + target + '-') ?? await cached('/index.html');
    if (!html) throw error;
    return html;
  });
  const response = await networkFirst(request, '/index.html');
  // Redirects, errors and per-document bridge credentials always come from the live service.
  if (response.status !== 200 || response.redirected || response.type !== 'basic'
    || response.headers.get('cache-control')?.includes('no-store') || !response.headers.get('content-type')?.includes('text/html')) return response;
  const html = await response.clone().text();
  if (!html.includes('name="voidplayer-offline-shell"') || html.includes('name="voidplayer-page-bridge"')) return response;
  // Keep this window on the same module/Worker graph as its controlling cache until the new worker activates.
  return await cached('/index.html') ?? response;
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || request.headers.has('range') || request.headers.has('authorization')) return;
  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith(playerNavigation(request));
    return;
  }
  const key = url.pathname + url.search;
  if (!Object.hasOwn(assets, key)) {
    // A single window can opt into a waiting build while its siblings still use this worker.
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/') && /^[a-f0-9]{64}$/.test(url.searchParams.get('v')))
      event.respondWith(retained(key, cachePrefix).then(hit => hit ?? fetch(request)));
    return;
  }
  if (url.pathname === '/index.html') return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/') || url.pathname === '/startup-guard.js' || url.pathname === '/theme-init.js') {
    event.respondWith(cached(key).then(hit => hit ?? fetch(request)));
  } else {
    // The install manifest stays current so the browser can discover identity and icon updates.
    event.respondWith(networkFirst(request, key));
  }
});
