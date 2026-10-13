import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { prepareStaticAssets, verifyStaticAssets, digest } from '../../scripts/static-assets.mjs';
import { StaticAssets } from '../../server/static-assets.ts';
import { serveFile } from '../../server/http-utils.ts';
import { httpFetch } from '../helpers/http-request.ts';

test('static assets negotiate verified compression, immutable versions, revalidation and raw ranges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-static-'));
  const name = '/vendor/test/core.wasm', bytes = Buffer.from('wasm-asset-'.repeat(2000));
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes); await writeFile(path.join(root, 'index.html'), 'current entry');
  await prepareStaticAssets(root);
  await verifyStaticAssets(root);
  const manifestFile = path.join(root, 'static-assets.json');
  const originalManifest = await readFile(manifestFile, 'utf8');
  const incomplete = JSON.parse(originalManifest); delete incomplete.assets[name];
  await writeFile(manifestFile, JSON.stringify(incomplete));
  await assert.rejects(verifyStaticAssets(root), /Missing static asset/);
  await writeFile(manifestFile, originalManifest);
  // Resolve macOS /var -> /private/var, matching the production static root.
  const { realpath } = await import('node:fs/promises');
  const real = await realpath(root), assets = new StaticAssets(real);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const operation = url.pathname === '/media' ? serveFile(req, res, file)
      : assets.serve(req, res, url, path.join(real, url.pathname));
    operation.catch(error => { res.statusCode = 500; res.end(String(error)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (suffix, headers = {}, method = 'GET') => httpFetch(base + suffix, { headers, method });
  const versioned = name + '?v=' + digest(bytes);
  try {
    const br = await get(versioned, { 'accept-encoding': 'gzip, br' });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.match(br.headers.get('cache-control'), /immutable/); assert.equal(br.headers.get('vary'), 'Accept-Encoding');
    assert.equal(br.headers.get('content-type'), 'application/wasm');
    assert.deepEqual(brotliDecompressSync(Buffer.from(await br.arrayBuffer())), bytes);
    const head = await get(versioned, { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.headers.get('content-length'), br.headers.get('content-length')); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const cached = await get(versioned, { 'accept-encoding': 'br', 'if-none-match': 'W/' + br.headers.get('etag') });
    assert.equal(cached.status, 304); assert.equal(cached.headers.get('vary'), 'Accept-Encoding');
    const gzip = await get(versioned, { 'accept-encoding': 'br;q=0, gzip' });
    assert.equal(gzip.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(gunzipSync(Buffer.from(await gzip.arrayBuffer())), bytes);
    const plain = await get(versioned, { 'accept-encoding': 'identity' });
    assert.equal(plain.headers.get('content-encoding'), null); assert.notEqual(plain.headers.get('etag'), br.headers.get('etag'));
    const range = await get(versioned, { 'accept-encoding': 'br', range: 'bytes=3-12' });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-encoding'), null);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(3, 13));
    assert.equal((await get(versioned, { range: 'bytes=999999-' })).status, 416);
    assert.equal((await get(name + '?v=' + '0'.repeat(64))).status, 409);
    assert.equal((await get(name)).headers.get('cache-control'), 'no-cache');
    assert.equal((await get('/index.html')).headers.get('cache-control'), 'no-cache');
    const media = await get('/media', { 'accept-encoding': 'br', range: 'bytes=0-9' });
    assert.equal(media.status, 206); assert.equal(media.headers.get('cache-control'), 'no-store'); assert.equal(media.headers.get('content-encoding'), null);
    assert.equal((await get(versioned, { 'accept-encoding': 'identity;q=0, br;q=0, gzip;q=0' })).status, 406);
    await writeFile(file + '.br', 'stale sidecar');
    await assert.rejects(verifyStaticAssets(root), /Static representation mismatch/);
    assert.equal((await get(versioned, { 'accept-encoding': 'br' })).headers.get('content-encoding'), null, 'corrupt sidecar falls back to verified identity');
    if (process.platform !== 'win32') {
      await rm(file + '.gz'); await symlink(path.join(os.tmpdir(), 'outside-asset'), file + '.gz');
      assert.equal((await get(versioned, { 'accept-encoding': 'gzip' })).headers.get('content-encoding'), null);
    }
    await writeFile(file, 'new version');
    assert.equal((await get(versioned)).status, 409, 'an old immutable URL never serves replacement bytes');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
