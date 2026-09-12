import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('development serves the admin entry for status-link and direct URLs', async () => {
  // A second Vite server must never rewrite the running developer's optimizer cache.
  const cacheDir = await mkdtemp(join(tmpdir(), 'vp-vite-routing-'));
  const web = await createServer({
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  try {
    await web.listen();
    const address = web.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/admin', '/admin/', '/admin?tab=logs', '/admin/index.html']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, /id="admin-app"/, route);
      assert.match(html, /\/src\/admin\/main\.ts/, route);
      assert.doesNotMatch(html, /\/src\/bootstrap\.ts/, route);
    }
    const player = await (await fetch(base + '/')).text();
    assert.match(player, /\/src\/bootstrap\.ts/);
    assert.doesNotMatch(player, /id="admin-app"/);
    for (const route of ['/src/packet-worker.ts?worker_file&type=module', '/node_modules/vite/dist/client/env.mjs']) {
      const resource = await fetch(base + route);
      assert.equal(resource.status, 200);
      assert.equal(resource.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(resource.headers.get('cross-origin-embedder-policy'), 'require-corp');
      const etag = resource.headers.get('etag'); assert.ok(etag);
      const cached = await fetch(base + route, { headers: { 'if-none-match': etag } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(cached.headers.get('cross-origin-embedder-policy'), 'require-corp');
    }
  } finally { await web.close(); await rm(cacheDir, { recursive: true, force: true }); }
});

test('development API proxy preserves browser origin for explicit identity actions', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  const { adminWriteAllowed } = await import('../server/admin.ts');
  const api = createHttpServer((req, res) => { res.writeHead(adminWriteAllowed(req, 'identity') ? 200 : 403); res.end(); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  const cacheDir = await mkdtemp(join(tmpdir(), 'vp-vite-proxy-'));
  const web = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), cacheDir,
    logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    server: { host: '127.0.0.1', port: 0, watch: null, proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } } },
  });
  try {
    await web.listen(); const port = web.httpServer!.address(); assert.ok(port && typeof port !== 'string');
    const base = `http://127.0.0.1:${port.port}`;
    const post = (origin: string) => fetch(base + '/api/identity', { method: 'POST', headers: { origin, 'x-voidplayer-action': 'identity' } });
    assert.equal((await post(base)).status, 200);
    assert.equal((await post('https://other.test')).status, 403);
  } finally { await web.close(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(cacheDir, { recursive: true, force: true }); }
});
