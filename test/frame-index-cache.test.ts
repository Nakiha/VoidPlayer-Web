import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../server/library.ts';
import { AdminController } from '../server/admin.ts';
import { loadConfig } from '../server/config.ts';
import { createMediaServer } from '../server/app.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex } from '../src/flv-index-cache.ts';
import { syntheticFlv } from './flv-fixture.ts';

test('shared frame indexes persist, respect versions and clear permissions, and expire only for confirmed removal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-frame-index-'));
  const media = path.join(root, 'media'); await mkdir(media); await mkdir(path.join(root, 'data'));
  const bytes = syntheticFlv(); await writeFile(path.join(media, 'one.flv'), bytes);
  const config = await loadConfig(['--folder', media], 'production', root); config.dataDir = path.join(root, 'data');
  const database = path.join(root, 'data', 'library.sqlite');
  let library = new MediaLibraryIndex([media], { database, watch: false }); await library.refresh();
  const entry = library.browse().entries[0];
  const reader = new FlvReader({ file: new Blob([bytes]) }); const document = serializeFlvIndex(await demuxFlv(reader), bytes.length); reader.close();
  library.frameIndexes.put(entry.id, entry.version!, entry.size, document, 0);
  await library.close(); library = new MediaLibraryIndex([media], { database, watch: false });
  assert.deepEqual(library.frameIndexes.get(entry.id, entry.version!).index, document, 'startup does not purge retained roots');
  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: [media], library, admin, onLog() {} }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoint = `${base}/api/media/${entry.id}/frame-index?v=${entry.version}`;
  const upload = (epoch: number, index: unknown = document, origin = base) => fetch(endpoint, { method: 'POST', headers: { origin, 'x-voidplayer-action': 'frame-index', 'content-type': 'application/json' }, body: JSON.stringify({ epoch, index }) });
  try {
    assert.equal((await fetch(endpoint)).status, 200);
    assert.equal((await upload(0, document, 'https://evil.invalid')).status, 403);
    assert.equal((await upload(0, { ...document, packets: [[entry.size, 10, 0, 0, 1]] })).status, 400);
    assert.equal((await fetch(base + '/api/admin/frame-indexes', { method: 'DELETE' })).status, 403);
    const removed = await fetch(base + '/api/admin/frame-indexes', { method: 'DELETE', headers: { origin: base, 'x-voidplayer-action': 'admin' } });
    assert.deepEqual(await removed.json(), { removed: 1 });
    assert.equal((await upload(0)).status, 409, 'in-flight uploads cannot undo a clear');
    assert.equal((await upload(1)).status, 201);
    await rename(media, media + '-offline'); await library.refresh(); assert.equal(library.frameIndexes.list().count, 1, 'offline storage preserves cache');
    await rename(media + '-offline', media); await library.refresh(); assert.equal(library.frameIndexes.list().count, 1);
    await writeFile(path.join(media, 'one.flv'), Buffer.concat([bytes, Buffer.from([0])])); await library.refresh();
    assert.equal(library.frameIndexes.list().count, 0, 'modified files lose old caches'); assert.equal((await fetch(endpoint)).status, 409);
    const changed = library.browse().entries[0]; library.frameIndexes.put(changed.id, changed.version!, changed.size, { ...document, size: changed.size }, 1);
    await rm(path.join(media, 'one.flv')); await library.refresh(); assert.equal(library.frameIndexes.list().count, 0, 'confirmed removal purges cache');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await admin.close(); await library.close(); await rm(root, { recursive: true, force: true }); }
});
