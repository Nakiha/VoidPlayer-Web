import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { FrameIndexStore, prepareFrameIndex } from '../../server/frame-index-store.ts';
import { MediaIndexQueryStore } from '../../server/media-index-query.ts';
import { FLV_MEDIA_INDEX_IDENTITY as flv, JS_TS_MEDIA_INDEX_IDENTITY as ts } from '../../shared/media/indexing/media-index-identity.ts';
import type { MediaIndexIdentity } from '../../shared/media/indexing/media-index-identity.ts';
import { TS_PACKET_BUILD } from '../../shared/media/indexing/ts-packet-index.ts';
import { parseFlvIndex } from '../../shared/media/indexing/flv-index-cache.ts';
import { flvMediaTiming } from '../../shared/media/containers/flv-demux.ts';
import { runSourceQuery } from '../../shared/analysis/metadata/adapters.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-committed-query-')), media = path.join(dir, 'media'), database = path.join(dir, 'index.sqlite');
  await mkdir(media); await writeFile(path.join(media, 'clip.flv'), Buffer.alloc(10000));
  const library = new MediaLibraryIndex([media], { database, watch: false }); await library.refresh();
  const entry = library.browse().entries[0], source = `${entry.id}@${entry.version}`;
  const db = openIndexDatabase(database), server = createMediaServer({ roots: [media], library, onLog() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); await library.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = (i: MediaIndexIdentity) => `${base}/api/media/${entry.id}/index-query?${new URLSearchParams({ v: entry.version!, kind: i.kind, stream: i.streamKey, schema: String(i.schemaVersion), indexer: i.indexerBuild })}`;
  const read = async (endpoint = url(flv)) => { const res = await fetch(endpoint), body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); return body; };
  const flvDoc = { schema: 3, size: entry.size, codec: 'h264', description: [1, 100, 0, 31, 255, 224, 0],
    packets: [[40, 10, 40000, 0, 1], [80, 12, 0, 40000, 0], [120, 14, 120000, 80000, 0], [160, 16, 120000, 120000, 0]] };
  const tsDoc = { schema: 2, kind: 'js-ts-packets', build: TS_PACKET_BUILD, sourceVersion: source, size: entry.size, streamKey: 'video:0', pid: 256, codec: 'h264', configuration: [1], completeness: { state: 'complete', packets: 3 },
    packets: [9000, 18000, null].map((pts, au) => ({ au, locator: 188 * au, pesOffset: pts === null ? null : 188 * au, configuration: 0,
      timestamp: (au + 1) / 10, ptsUs: (au + 1) * 100000, durationUs: 100000, size: au + 10, key: !au,
      timing: { pts, dts: au ? null : 0, timebase: [1, 90000], origin: pts === null ? 'derived' : 'pes' } })) };
  const commit = (doc = flvDoc, identity = flv, scan = true) => library.frameIndexes.commit(entry.id, entry.version!, prepareFrameIndex(doc, entry.size, identity, source, scan ? { scannedBytes: entry.size } : undefined), library.frameIndexes.epoch);
  return { dir, media, library, entry, db, server, base, url, read, flvDoc, tsDoc, commit, source };
}
const envelope = (header: unknown) => JSON.stringify({ header, sha256: createHash('sha256').update(JSON.stringify(header)).digest('hex') });

test('FLV commit projection matches authoritative timing and statistics; uploads do not prove completeness', async t => {
  const f = await fixture(t); f.commit(f.flvDoc, flv, false);
  let o = (await f.read()).overview;
  assert.equal(o.state, 'partial'); assert.equal(o.reason, 'integrity-unknown'); assert.equal(o.scannedBytes, null);
  assert.equal(o.evidence.provenance, 'validated-upload');
  assert.equal(o.technical.codec.value, 'h264'); assert.equal(o.technical.codedWidth.value, null);
  assert.equal(o.technical.durationUs.value, null); assert.equal(o.technical.indexedDurationUs.status, 'derived');
  const index = parseFlvIndex(f.flvDoc, f.entry.size), timing = flvMediaTiming(index);
  assert.equal(o.clock.firstPts, String(timing.firstPtsUs)); assert.equal(o.technical.indexedDurationUs.value, String(timing.durationUs));
  const shared = runSourceQuery(index.packets, { mediaId: 'test', firstPtsUs: 0, durationUs: 200000, sourceVersion: 'test', indexRevision: 1,
    capability: { hasSize: true, hasDts: true, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: 'complete' }, coverageUs: null },
  { requestId: 1, axis: 'pts', startUs: -1, endUs: 200000, pixelWidth: 10, bitrateWindowUs: 100000 });
  assert.equal(o.recordCount, shared.samples.length); assert.equal(o.statistics.payloadBytes, shared.samples.reduce((n, p) => n + p.sizeBytes!, 0));
  assert.deepEqual(o.coverage.pts, { count: 4, missing: 0, minTick: '0', maxTick: '120000' });
  assert.deepEqual(o.coverage.dts, { count: 4, missing: 0, minTick: '0', maxTick: '120000' });
  assert.equal(o.stablePresentationUs, null); assert.equal(o.coverage.continuousPresentation, null);
  // A second submission cannot mix its evidence/header with the first document.
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  f.commit({ ...f.flvDoc, packets: f.flvDoc.packets.slice(0, 2) });
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before);
  f.library.frameIndexes.remove(); f.commit(); o = (await f.read()).overview;
  assert.equal(o.state, 'complete'); assert.equal(o.recordCount, 4); assert.equal(o.scannedBytes, f.entry.size);
  assert.equal(o.capabilities.records.ready, true);
  assert.deepEqual(f.library.frameIndexes.get(f.entry.id, f.entry.version!).index, f.flvDoc, 'legacy whole-document GUI contract is unchanged');
  const records = await f.read(f.url(flv) + '&view=records&startTick=0&endTick=200000&byteBudget=8192');
  assert.equal(records.summary.count, 4); assert.equal(records.exhausted, true); assert.equal(records.nextCursor, null);
  assert.equal(records.overview.capabilities.records.reason, null);
  assert.deepEqual(records.records.map((r: any) => r.ptsTick), ['40000', '0', '120000', '120000']);
  assert.ok(Buffer.byteLength(JSON.stringify(records)) <= 8192);
});

test('TS raw PES PTS/DTS, derived presentation, source binding and duplicate commit remain distinct', async t => {
  const f = await fixture(t);
  f.library.frameIndexes.commit(f.entry.id, f.entry.version!, prepareFrameIndex(f.tsDoc, f.entry.size, ts, f.source), 0);
  const page = await f.read(f.url(ts)), o = page.overview;
  assert.equal(o.state, 'complete'); assert.equal(o.technical.pid.value, 256); assert.equal(o.clock.firstPts, null);
  assert.deepEqual(o.coverage.pts, { count: 2, missing: 1, minTick: '9000', maxTick: '18000' });
  assert.deepEqual(o.coverage.dts, { count: 1, missing: 2, minTick: '0', maxTick: '0' });
  assert.deepEqual(o.coverage.effectivePtsUs, { min: '100000', max: '300000' });
  assert.equal(o.technical.indexedDurationUs.value, '300000'); assert.equal(o.statistics.payloadBytes, 33);
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  const changed = structuredClone(f.tsDoc); changed.packets[0].size++;
  f.library.frameIndexes.commit(f.entry.id, f.entry.version!, prepareFrameIndex(changed, f.entry.size, ts, f.source), 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before, 'JS seal must belong to the winning document');
  assert.equal(f.library.frameIndexes.has(f.entry.id, f.entry.version!, 'js-ts', ts), true);
  const stored = JSON.parse(String(f.db.prepare("SELECT semantic_json FROM media_index_manifests WHERE kind='js-ts'").get()!.semantic_json));
  stored.header.sourceVersion = 'another@source';
  f.db.prepare('UPDATE media_index_manifests SET semantic_json=?').run(envelope(stored.header));
  assert.equal((await f.read(f.url(ts))).overview.reason, 'semantic-header-invalid');
  assert.equal((await f.read(f.url(ts))).overview.recordCount, null);
});

test('missing, oversized, damaged and future headers are bounded unknowns; reads never inspect or migrate whole payloads', async t => {
  const f = await fixture(t); f.commit();
  const saved = String(f.db.prepare('SELECT semantic_json FROM media_index_manifests').get()!.semantic_json);
  const read = () => f.read();
  for (const [value, reason] of [[null, 'semantic-header-missing'], ['{bad', 'semantic-header-invalid'], ['x'.repeat(8193), 'semantic-header-too-large']] as const) {
    f.db.prepare('UPDATE media_index_manifests SET semantic_json=?').run(value);
    const before = f.db.prepare('SELECT * FROM media_index_manifests').all(), o = (await read()).overview;
    assert.equal(o.state, 'unknown'); assert.equal(o.reason, reason); assert.equal(o.recordCount, null); assert.equal(o.technical.codec.value, null);
    assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before);
  }
  const h = JSON.parse(saved).header;
  for (const mutate of [(v: any) => v.version++, (v: any) => v.pts.count++, (v: any) => v.geometryReason = '/private/path']) {
    const changed = structuredClone(h); mutate(changed);
    f.db.prepare('UPDATE media_index_manifests SET semantic_json=?').run(envelope(changed));
    const response = await read(); assert.equal(response.overview.state, 'unknown'); assert.equal(JSON.stringify(response).includes('/private/'), false);
  }
  f.db.prepare('UPDATE media_index_manifests SET semantic_json=?').run(saved.replace('"payloadBytes":52', '"payloadBytes":53'));
  assert.equal((await read()).overview.reason, 'semantic-header-invalid', 'checksum rejects structurally valid header damage');
  f.db.prepare('UPDATE media_index_batches SET payload=zeroblob(64000000)').run();
  assert.equal((await read()).overview.reason, 'semantic-header-missing', 'payload mutation invalidates the projection');
  // Guard every SQL statement, including inventory. Even an enormous legacy
  // payload is never fetched, hashed, parsed, sliced or migrated by semantic GET.
  const queries = new MediaIndexQueryStore(new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { assert.doesNotMatch(sql, /media_index_batches|json_extract|\bpayload\b/i); return target.prepare(sql); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }));
  assert.equal(queries.query(f.entry.id, f.entry.version!, flv).overview.state, 'unknown');
  assert.equal(queries.inventory(f.entry.id, f.entry.version!, 0).indexes[0].state, 'unknown');
});

test('partial/failed snapshots, source changes and offline files never become complete', async t => {
  const f = await fixture(t); f.commit();
  const endpoint = f.url(flv) + '&view=records&startTick=0&endTick=1';
  const first = await f.read(endpoint);
  f.db.prepare("UPDATE media_index_manifests SET complete=0,state='failed'").run();
  let o = (await f.read()).overview; assert.equal(o.state, 'partial'); assert.equal(o.reason, 'build-failed'); assert.equal(o.terminal, false);
  assert.equal((await fetch(endpoint + '&cursor=' + first.snapshot + '.0.0')).status, 409);
  f.db.prepare("UPDATE media_index_manifests SET state='building'").run();
  o = (await f.read()).overview; assert.equal(o.reason, 'build-in-progress');
  await rename(path.join(f.media, 'clip.flv'), path.join(f.media, 'offline'));
  assert.equal((await fetch(f.url(flv))).status, 409);
  await writeFile(path.join(f.media, 'clip.flv'), 'replacement'); await f.library.refresh();
  const stale = await fetch(f.url(flv)); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'media-version-changed');
  assert.equal(f.library.frameIndexes.list().count, 0);
});

test('older databases gain an empty header column without reading or rewriting cached documents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-header-upgrade-')), media = path.join(dir, 'media'), database = path.join(dir, 'index.sqlite');
  await mkdir(media); await writeFile(path.join(media, 'clip.flv'), Buffer.alloc(10000));
  let library: MediaLibraryIndex | undefined = new MediaLibraryIndex([media], { database, watch: false });
  try {
    await library.refresh(); const entry = library.browse().entries[0];
    const doc = { schema: 3, size: entry.size, codec: 'h264', description: [1, 100, 0, 31, 255, 224, 0], packets: [[40, 10, 0, 0, 1]] };
    library.frameIndexes.put(entry.id, entry.version!, entry.size, doc, 0);
    await library.close(); library = undefined;
    const db = openIndexDatabase(database);
    db.exec('DELETE FROM media_index_batches');
    const identity = [entry.id, entry.version!, flv.kind, flv.streamKey, flv.schemaVersion, flv.indexerBuild];
    const payload = JSON.stringify(doc);
    db.prepare('INSERT INTO media_index_batches(media_id,media_version,kind,stream_key,schema_version,indexer_build,seq,payload,bytes,frames,created_at) VALUES(?,?,?,?,?,?,0,?,?,1,0)').run(...identity, payload, Buffer.byteLength(payload));
    db.exec('UPDATE media_index_manifests SET last_seq=0');
    for (const name of ['insert', 'update', 'delete', 'update_old']) db.exec(`DROP TRIGGER packet_batch_${name}`);
    db.exec('ALTER TABLE media_index_manifests DROP COLUMN packet_storage');
    for (const name of ['insert', 'update', 'delete', 'update_old']) db.exec(`DROP TRIGGER semantic_batch_${name}`);
    db.exec('ALTER TABLE media_index_manifests DROP COLUMN semantic_json'); db.close();
    library = new MediaLibraryIndex([media], { database, watch: false });
    const reopened = openIndexDatabase(database);
    try {
      const queries = new MediaIndexQueryStore(reopened);
      assert.equal(queries.query(entry.id, entry.version!, flv).overview.reason, 'semantic-header-missing');
      assert.equal(reopened.prepare('SELECT payload FROM media_index_batches').get()!.payload, payload);
      assert.deepEqual(library.frameIndexes.get(entry.id, entry.version!).index, doc);
      // Neither a warm read nor a duplicate submission silently migrates the old row.
      library.frameIndexes.put(entry.id, entry.version!, entry.size, doc, 0);
      assert.equal(queries.query(entry.id, entry.version!, flv).overview.reason, 'semantic-header-missing');
      library.frameIndexes.remove(); library.frameIndexes.put(entry.id, entry.version!, entry.size, doc, library.frameIndexes.epoch);
      assert.equal(queries.query(entry.id, entry.version!, flv).overview.reason, 'integrity-unknown');
    } finally { reopened.close(); }
  } finally { await library?.close(); await rm(dir, { recursive: true, force: true }); }
});


test('concurrent whole-document commits keep the winning packet table, header and JS seal together', async t => {
  const f = await fixture(t);
  const modified = structuredClone(f.tsDoc); modified.packets[0].size += 100;
  const prepared = [f.tsDoc, modified].map(doc => prepareFrameIndex(doc, f.entry.size, ts, f.source));
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.storeModule), import(workerData.sqliteModule)]).then(([{FrameIndexStore},{openIndexDatabase}]) => {
      const db = openIndexDatabase(workerData.database); db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
      parentPort.once('message', () => {
        try { new FrameIndexStore(db).commit(workerData.id,workerData.version,workerData.prepared,0); }
        finally { db.close(); parentPort.close(); }
      }); parentPort.postMessage('ready');
    });`;
  const workers = prepared.map(value => new Worker(code, { eval: true, workerData: { database: path.join(f.dir, 'index.sqlite'),
    storeModule: new URL('../../server/frame-index-store.ts', import.meta.url).href, sqliteModule: new URL('../../server/sqlite.ts', import.meta.url).href,
    id: f.entry.id, version: f.entry.version!, prepared: value } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const exits = workers.map(worker => once(worker, 'exit'));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  workers.forEach(worker => worker.postMessage('commit'));
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  assert.equal(f.library.frameIndexes.has(f.entry.id, f.entry.version!, 'js-ts', ts), true);
  const winner = JSON.parse(f.library.frameIndexes.getJson(f.entry.id, f.entry.version!, 'js-ts', ts)).index;
  const o = (await f.read(f.url(ts))).overview;
  assert.equal(o.statistics.payloadBytes, winner.packets.reduce((n: number, p: { size: number }) => n + p.size, 0));
  assert.equal(o.state, 'complete');
});

test('packet pages bound traversal, response and TEXT allocations independently; nonmatches always advance', async t => {
  const f = await fixture(t);
  const doc = { ...f.flvDoc, packets: Array.from({ length: 6000 }, (_, i) => [40 + i, 1, i * 1000, i * 1000, Number(i === 0)]) };
  f.commit(doc);
  const query = { axis: 'pts' as const, startTick: '-100', endTick: '-1', limit: 256, byteBudget: 8192 };
  const store = new MediaIndexQueryStore(f.db);
  const first = store.query(f.entry.id, f.entry.version!, flv, query) as any;
  assert.equal(first.inspected, 2048); assert.equal(first.records.length, 0); assert.equal(first.exhausted, false);
  assert.ok(first.readBytes <= 262144); assert.ok(first.nextCursor); assert.equal(first.summary.count, 0);
  let cursor = first.nextCursor, inspected = first.inspected;
  do { const p = store.query(f.entry.id, f.entry.version!, flv, query, cursor) as any; inspected += p.inspected; cursor = p.nextCursor; } while (cursor);
  assert.equal(inspected, 6000);
  // Large seq=0 metadata is never part of a semantic record read.
  const saved = f.db.prepare('SELECT packet_storage,semantic_json FROM media_index_manifests').get()!;
  f.db.prepare('UPDATE media_index_batches SET payload=zeroblob(64000000) WHERE seq=0').run();
  f.db.prepare('UPDATE media_index_manifests SET packet_storage=?,semantic_json=?').run(saved.packet_storage, saved.semantic_json);
  assert.equal((store.query(f.entry.id, f.entry.version!, flv, query) as any).inspected, 2048);
  // Legal bounded chunks padded near their byte ceiling force the read budget
  // before the traversal budget. Even these pages must make progress.
  const batches = f.db.prepare('SELECT seq,payload FROM media_index_batches WHERE seq>0').all();
  for (const b of batches) {
    const payload = JSON.stringify({ ...JSON.parse(String(b.payload)), padding: 'x'.repeat(60000) });
    assert.ok(Buffer.byteLength(payload) < 65536);
    f.db.prepare('UPDATE media_index_batches SET payload=?,bytes=? WHERE seq=?').run(payload, Buffer.byteLength(payload), b.seq);
  }
  f.db.prepare('UPDATE media_index_manifests SET packet_storage=?,semantic_json=?').run(saved.packet_storage, saved.semantic_json);
  const bounded = store.query(f.entry.id, f.entry.version!, flv, query) as any;
  assert.ok(bounded.readBytes <= 262144); assert.ok(bounded.chunksRead <= 4); assert.ok(bounded.inspected > 0 && bounded.inspected < 2048);
  assert.ok(bounded.nextCursor); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 8192);
});

test('invalidated, missing, duplicated, oversized, corrupt and future packet storage fails closed without migration', async t => {
  const f = await fixture(t);
  const doc = { ...f.flvDoc, packets: Array.from({ length: 130 }, (_, i) => [40 + i, 1, i * 1000, i * 1000, Number(i === 0)]) };
  const query = { axis: 'pts' as const, startTick: '0', endTick: '9999999', limit: 256, byteBudget: 262144 };
  const store = new MediaIndexQueryStore(f.db);
  for (const damage of ['missing', 'duplicate', 'oversized', 'syntax', 'checksum', 'version', 'packet', 'frames', 'bytes', 'commit'] as const) {
    f.library.frameIndexes.remove(); f.commit(doc);
    const saved = f.db.prepare('SELECT packet_storage,semantic_json FROM media_index_manifests').get()!;
    const chunk = JSON.parse(String(f.db.prepare('SELECT payload FROM media_index_batches WHERE seq=1').get()!.payload));
    if (damage === 'missing') f.db.exec('DELETE FROM media_index_batches WHERE seq=2');
    else if (damage === 'duplicate') f.db.exec('UPDATE media_index_batches SET payload=(SELECT payload FROM media_index_batches WHERE seq=1) WHERE seq=2');
    else if (damage === 'oversized') f.db.exec('UPDATE media_index_batches SET payload=zeroblob(64000000),bytes=64000000 WHERE seq=1');
    else if (damage === 'syntax') f.db.exec("UPDATE media_index_batches SET payload='{bad',bytes=4 WHERE seq=1");
    else if (damage === 'frames') f.db.exec('UPDATE media_index_batches SET frames=63 WHERE seq=1');
    else if (damage === 'bytes') f.db.exec('UPDATE media_index_batches SET bytes=999 WHERE seq=1');
    else {
      if (damage === 'checksum') chunk.sha256 = '0'.repeat(64);
      if (damage === 'version') chunk.version = 2;
      if (damage === 'commit') chunk.commitId = '0'.repeat(36);
      if (damage === 'packet') { chunk.packets[2][0] = -1; chunk.sha256 = createHash('sha256').update(JSON.stringify(chunk.packets)).digest('hex'); }
      const payload = JSON.stringify(chunk);
      f.db.prepare('UPDATE media_index_batches SET payload=?,bytes=? WHERE seq=1').run(payload, Buffer.byteLength(payload));
    }
    assert.equal((store.query(f.entry.id, f.entry.version!, flv, query) as any).overview.capabilities.records.ready, false, damage);
    // Also test the reader's own defensive checks, independently of triggers.
    f.db.prepare('UPDATE media_index_manifests SET packet_storage=?,semantic_json=?').run(saved.packet_storage, saved.semantic_json);
    assert.throws(() => store.query(f.entry.id, f.entry.version!, flv, query), (e: any) => e.code === 'index-cache-invalid', damage);
  }
  f.library.frameIndexes.remove(); f.commit(doc);
  const saved = f.db.prepare('SELECT packet_storage FROM media_index_manifests').get()!;
  for (const mutate of [(s: any) => s.version++, (s: any) => s.sourceVersion = 'stale', (s: any) => s.identity.schemaVersion++, (s: any) => s.chunks++]) {
    const storage = JSON.parse(String(saved.packet_storage)); mutate(storage);
    f.db.prepare('UPDATE media_index_manifests SET packet_storage=?').run(JSON.stringify(storage));
    const p = store.query(f.entry.id, f.entry.version!, flv, query) as any;
    assert.equal(p.overview.capabilities.records.ready, false); assert.equal(p.inspected, 0);
    assert.equal(p.overview.capabilities.records.reason, 'packet-storage-invalid-or-unsupported');
  }
});

test('chunk insertion failure rolls back document, seal, header and manifest; retry commits one authority', async t => {
  const f = await fixture(t);
  const doc = { ...f.flvDoc, packets: Array.from({ length: 130 }, (_, i) => [40 + i, 1, i * 1000, i * 1000, Number(i === 0)]) };
  f.db.exec("CREATE TRIGGER inject_chunk_failure BEFORE INSERT ON media_index_batches WHEN new.seq=2 BEGIN SELECT RAISE(ABORT,'injected chunk failure'); END");
  assert.throws(() => f.commit(doc), /injected chunk failure/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_index_manifests').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_index_batches').get()!.n, 0);
  f.db.exec('DROP TRIGGER inject_chunk_failure'); f.commit(doc);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_index_batches').get()!.n, 4);
  assert.deepEqual(f.library.frameIndexes.get(f.entry.id, f.entry.version!).index, doc);
});

test('cancellation interrupts bounded traversal and closes the read snapshot', async t => {
  const f = await fixture(t); f.commit();
  const cancellation = new SharedArrayBuffer(4), query = { axis: 'pts' as const, startTick: '0', endTick: '200000', limit: 256, byteBudget: 16384 };
  const store = new MediaIndexQueryStore(new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes('FROM media_index_batches')) return statement;
      return new Proxy(statement, { get(s, method) { if (method === 'get') return (...args: any[]) => { const row = s.get(...args); Atomics.store(new Int32Array(cancellation), 0, 1); return row; }; const v = Reflect.get(s, method); return typeof v === 'function' ? v.bind(s) : v; } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }));
  assert.throws(() => store.query(f.entry.id, f.entry.version!, flv, query, undefined, cancellation), (e: any) => e.code === 'media-query-cancelled');
  assert.equal((new MediaIndexQueryStore(f.db).query(f.entry.id, f.entry.version!, flv, query) as any).records.length, 4);
  const alreadyCancelled = f.library.indexJobs.call('semantic-query', { id: f.entry.id, version: f.entry.version!, identity: flv, query, cancellation });
  await assert.rejects(alreadyCancelled, (e: any) => e.code === 'media-query-cancelled');
});


test('JS cache seal and packets use one snapshot across a concurrent clear and replacement', async t => {
  const f = await fixture(t), writer = f.library.frameIndexes;
  writer.commit(f.entry.id, f.entry.version!, prepareFrameIndex(f.tsDoc, f.entry.size, ts, f.source), 0);
  const replacement = structuredClone(f.tsDoc); replacement.packets[0].size++;
  let replaced = false;
  const reader = new FrameIndexStore(new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.startsWith('SELECT metadata_json FROM media_index_manifests')) return statement;
      return new Proxy(statement, { get(s, method) {
        if (method === 'get') return (...args: any[]) => {
          const row = s.get(...args);
          if (!replaced) {
            replaced = true; writer.remove();
            writer.commit(f.entry.id, f.entry.version!, prepareFrameIndex(replacement, f.entry.size, ts, f.source), writer.epoch);
          }
          return row;
        };
        const value = Reflect.get(s, method); return typeof value === 'function' ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }));
  assert.equal(reader.has(f.entry.id, f.entry.version!, 'js-ts', ts), true);
  assert.equal(replaced, true);
  assert.equal(writer.has(f.entry.id, f.entry.version!, 'js-ts', ts), true);
  assert.deepEqual(JSON.parse(writer.getJson(f.entry.id, f.entry.version!, 'js-ts', ts)).index, replacement);
});
