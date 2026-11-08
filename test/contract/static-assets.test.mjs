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
    const compressed = Buffer.from(await gzip.arrayBuffer());
    assert.equal(compressed.readUInt32LE(4), 0, 'shared assets have no build-time timestamp');
    assert.equal(compressed[9], 255, 'shared assets do not encode the host operating system');
    assert.deepEqual(gunzipSync(compressed), bytes);
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

test('frontend publication retains immutable versions and leaves the active entry intact after failure or retry', async () => {
  const { randomUUID } = await import('node:crypto');
  const { publishFrontend, sealFrontend, FrontendReleases, prepareBundledFrontend } = await import('../../server/frontend-releases.ts');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vp-publish-')), store = path.join(tmp, 'store');
  const indexFile = path.join(store, 'current.json'), wasm = 'vendor/test/test.wasm';
  const readIndex = async () => JSON.parse(await readFile(indexFile, 'utf8'));
  async function make(label) {
    const root = path.join(tmp, label), buildId = randomUUID();
    await mkdir(path.join(root, 'vendor/test'), {recursive:true}); await mkdir(path.join(root, 'assets')); await mkdir(path.join(root, 'admin'));
    await writeFile(path.join(root, wasm), label);
    await writeFile(path.join(root, 'build-info.json'), JSON.stringify({buildId,coreAssetDigests:{['/' + wasm]:digest(label)}}));
    await writeFile(path.join(root, 'assets/shared-hash.js'), 'shared');
    await writeFile(path.join(root, 'index.html'), '<head><script src="/assets/shared-hash.js"></script></head>' + label);
    await writeFile(path.join(root, 'admin/index.html'), label); await writeFile(path.join(root, 'manifest.webmanifest'), '{}');
    await writeFile(path.join(root, 'sw.js'), 'const assets = {};\n');
    await prepareStaticAssets(root); await sealFrontend(root);
    await verifyStaticAssets(root);
    return {root,buildId};
  }
  try {
    const [a,b,c,d,e] = await Promise.all(['A','B','C','D','E'].map(make));
    await publishFrontend(a.root,store,'bundle');
    for (const release of [b,c]) await publishFrontend(release.root,store);
    const releases = new FrontendReleases(store);
    assert.equal(path.basename((await releases.resolve('index.html','irrelevant')).root),c.buildId);
    assert.equal(path.basename((await releases.resolve(wasm,digest('A'))).root),a.buildId);
    assert.equal(path.basename((await releases.resolve(wasm,digest('B'))).root),b.buildId);
    assert.equal(await releases.resolve(wasm,digest('unknown')),undefined);
    const before = await readIndex();
    await writeFile(path.join(d.root,'admin/index.html'),'broken');
    await assert.rejects(publishFrontend(d.root,store),/Incomplete frontend build/);
    assert.deepEqual(await readIndex(),before);
    assert.equal(await prepareBundledFrontend(path.join(tmp, 'missing-bundle'),store),a.buildId);
    assert.equal(await prepareBundledFrontend(a.root,store),a.buildId);
    assert.equal((await readIndex()).releases[0].buildId,c.buildId);
    await mkdir(path.join(store,'.publishing'));
    await assert.rejects(publishFrontend(c.root,store),{code:'EEXIST'});
    assert.deepEqual(await readIndex(),before);
    await rm(path.join(store,'.publishing'),{recursive:true});
    await publishFrontend(c.root,store);
    assert.equal((await readIndex()).releases.length,3);
    await publishFrontend(a.root,store,'bundle'); // Restart with the same bundle after hot-publishing C.
    assert.equal((await readIndex()).releases[0].buildId,c.buildId);
    await publishFrontend(b.root,store); // Explicit frontend-only rollback.
    assert.equal((await readIndex()).releases[0].buildId,b.buildId);
    await writeFile(path.join(d.root,'admin/index.html'),'D');
    await publishFrontend(d.root,store);
    const old = await readIndex();
    for (const r of old.releases) r.retiredAt = r.publishedAt = 0;
    await writeFile(indexFile,JSON.stringify(old)); await publishFrontend(e.root,store);
    assert.ok((await readIndex()).releases.some(r => r.buildId === a.buildId),'running backend retains its own bundled core');
    assert.equal(await releases.resolve(wasm,digest('C')),undefined,'expired release outside the latest three is retired');
    assert.equal(path.basename((await releases.resolve(wasm,digest('B'))).root),b.buildId);

    // Import a complete pre-buildId distribution without modifying it.
    const legacy = await make('legacy');
    const legacyInfo = path.join(legacy.root,'build-info.json');
    const metadata = JSON.parse(await readFile(legacyInfo,'utf8')); delete metadata.buildId;
    await rm(path.join(legacy.root,'frontend-release.json')); await writeFile(legacyInfo,JSON.stringify(metadata));
    await prepareStaticAssets(legacy.root);
    const legacyId = await publishFrontend(legacy.root,store,'retain');
    assert.equal(await releases.currentBuildId(),e.buildId);
    assert.equal(path.basename((await releases.resolve(wasm,digest('legacy'))).root),legacyId);
    assert.equal(await publishFrontend(legacy.root,store),legacyId);
    await assert.rejects(readFile(path.join(legacy.root,'frontend-release.json')),{code:'ENOENT'});
  } finally { await rm(tmp,{recursive:true,force:true}); }
});
