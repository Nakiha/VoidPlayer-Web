import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { MediaIndexQueryStore } from '../../server/media-index-query.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { prepareFrameIndex } from '../../server/frame-index-store.ts';
import { FLV_MEDIA_INDEX_IDENTITY as flv, JS_TS_MEDIA_INDEX_IDENTITY as ts } from '../../shared/media/indexing/media-index-identity.ts';
import { TS_PACKET_BUILD } from '../../shared/media/indexing/ts-packet-index.ts';
import { parseTechnicalFilter, evaluateTechnicalEvidence, markTechnicalConflicts, TECHNICAL_FILTER_PATH, TECHNICAL_FILTER_LIMITS } from '../../shared/media/indexing/technical-filter.ts';
import { describeCachedIndex } from '../../shared/media/indexing/semantic-query.ts';

const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild: 'a'.repeat(40) };
const metadata = { schema: 3, kind: 'ffmpeg-container', size: 10000, codec: 'h264', width: 640, height: 360, timeBaseNum: 1, timeBaseDen: 1000,
  streamIndex: 0, indexerBuild: identity.indexerBuild, recordBytes: 48, firstPts: '0', originVerified: true, indexIntegrity: 'complete' };
async function fixture(t: TestContext, count = 1) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-technical-filter-')), media = path.join(dir, 'media'), database = path.join(dir, 'library.sqlite');
  await mkdir(media);
  for (let i = 0; i < count; i++) await writeFile(path.join(media, `clip-${i}.mp4`), Buffer.alloc(10000));
  const library = new MediaLibraryIndex([media], { database, watch: false });
  await library.refresh();
  const entries = library.browse().entries;
  const server = createMediaServer({ roots: [media], library, onLog() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const db = openIndexDatabase(database), store = new MediaIndexQueryStore(db);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); await library.close(); await rm(dir, { recursive: true, force: true }); });
  const query = (extra = 'codec=h264', chosen = entries) => parseTechnicalFilter(new URLSearchParams(chosen.map(e => ['candidate', `${e.id}@${e.version}`]).concat([...new URLSearchParams(extra)])));
  const url = (extra = 'codec=h264', chosen = entries) => base + TECHNICAL_FILTER_PATH + '?' + chosen.map(e => `candidate=${e.id}@${e.version}`).join('&') + '&' + extra;
  const put = (extra = {}, selected = entries[0], id = identity) => {
    const records = Buffer.alloc(48); records.writeBigInt64LE(0n, 0); records.writeBigInt64LE(0n, 8); records.writeBigInt64LE(40n, 16); records.writeBigInt64LE(-1n, 24); records.writeInt32LE(100, 32); records.writeUInt32LE(1, 36);
    return library.frameIndexes.put(selected.id, selected.version!, selected.size, { ...metadata, indexerBuild: id.indexerBuild, streamIndex: Number(id.streamKey.split(':')[1]), ...extra, count: 1, records: records.toString('base64') }, library.frameIndexes.epoch, id);
  };
  const read = async (endpoint = url()) => { const response = await fetch(endpoint), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  return { dir, media, database, db, store, library, entries, base, url, query, put, read };
}

test('filter normalization, inclusive boundaries and unknown evidence preserve identity scope', () => {
  const candidate = `${'a'.repeat(24)}@${'b'.repeat(24)}`;
  const q = parseTechnicalFilter(new URLSearchParams(`candidate=${candidate}&codec=H264&minWidth=640&maxWidth=640&minHeight=360&maxHeight=360&recordsReady=1`));
  assert.equal(q.filters.codec, 'h264');
  const overview = describeCachedIndex({ complete: true, state: 'complete', recordCount: 1, scannedBytes: 10000, stablePresentationUs: 0, metadata }, identity);
  assert.equal(evaluateTechnicalEvidence(overview, q.filters).state, 'match');
  assert.equal(evaluateTechnicalEvidence(overview, { minWidth: 641 }).state, 'not-match');
  assert.equal(evaluateTechnicalEvidence(overview, { codec: 'hevc' }).state, 'not-match');
  assert.equal(evaluateTechnicalEvidence({ ...overview, state: 'partial' }, { codec: 'hevc' }).state, 'unknown');
  assert.equal(evaluateTechnicalEvidence(overview, { codec: 'hevc' }, false).state, 'unknown');
  assert.equal(evaluateTechnicalEvidence({ ...overview, technical: { ...overview.technical, width: { value: null, status: 'unknown', source: 'unavailable' } } }, { codec: 'hevc', minWidth: 1 }).state, 'unknown');
  const second = evaluateTechnicalEvidence({ ...overview, identity: { ...identity, indexerBuild: 'b'.repeat(40) }, technical: { ...overview.technical, width: { value: 1920, status: 'known', source: 'container-index' } } }, q.filters);
  const first = evaluateTechnicalEvidence(overview, q.filters);
  markTechnicalConflicts([first, second]); assert.equal(first.state, 'unknown'); assert.equal(second.state, 'unknown');
  for (const extra of ['', '&codec=h264&codec=hevc', '&duration=1', '&offset=0', '&cursor=x', '&minWidth=0', '&minHeight=1.5', '&maxWidth=16385', '&minWidth=2&maxWidth=1', '&recordsReady=0', '&byteBudget=8191', '&codec=%2Fprivate']) {
    assert.throws(() => parseTechnicalFilter(new URLSearchParams(`candidate=${candidate}${extra}`)));
  }
  assert.throws(() => parseTechnicalFilter(new URLSearchParams(`candidate=${candidate}&candidate=${candidate}&codec=h264`)));
});

test('HTTP candidates distinguish cache matches from unseen streams without probing or mutation', async t => {
  const f = await fixture(t, 2); f.put();
  f.library.refresh = async () => { throw Error('scan forbidden'); }; f.library.indexJobs.startBuild = () => { throw Error('build forbidden'); };
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  const result = await f.read(f.url('codec=h264&minWidth=640&maxWidth=640&recordsReady=1'));
  assert.equal(result.pagination, 'none'); assert.equal(result.nextCursor, null); assert.equal(result.libraryTotal, null); assert.equal(result.streamInventoryComplete, false);
  const match = result.candidates.find((c: any) => c.source.id === f.entries[0].id), missing = result.candidates.find((c: any) => c.source.id === f.entries[1].id);
  assert.equal(match.state, 'match'); assert.equal(match.evidence[0].state, 'match'); assert.deepEqual(match.evidence[0].identity, identity);
  assert.equal(match.evidence[0].geometryScope, 'cached-stream-metadata'); assert.match(match.evidence[0].fields.recordsReady.reason, /payload-not-read/);
  assert.equal(missing.state, 'unknown'); assert.deepEqual(missing.evidence, []);
  const negative = await f.read(f.url('codec=hevc'));
  const candidate = negative.candidates.find((c: any) => c.source.id === f.entries[0].id);
  assert.equal(candidate.state, 'unknown'); assert.equal(candidate.evidence[0].state, 'not-match');
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before, 'read never touches LRU');
  assert.equal(JSON.stringify(result).includes(f.dir), false);
  const discovery = await (await fetch(f.base + '/api/agent')).json();
  assert.equal(discovery.capabilities.find((c: any) => c.id === 'media.technical-filter').readiness, 'per-source');
  assert.equal(discovery.technicalFilter.endpoint, TECHNICAL_FILTER_PATH);
  assert.equal((await (await fetch(f.base + '/api/media/query-schema')).json()).technicalFilter.version, 1);
  assert.equal((await fetch(f.url(), { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.url() + '&cursor=x')).status, 400);
});

test('partial, legacy, oversized, unsupported and conflicting caches cannot establish negatives', async t => {
  const f = await fixture(t); f.put(); f.db.prepare("UPDATE media_index_manifests SET complete=0,state='streaming'").run();
  assert.equal((await f.read(f.url('codec=hevc'))).candidates[0].evidence[0].state, 'unknown');
  f.put(); f.db.prepare('UPDATE media_index_manifests SET metadata_json=?').run(' '.repeat(1024 * 1024));
  assert.equal((await f.read()).candidates[0].evidence[0].state, 'unknown');
  f.db.prepare('DELETE FROM media_index_manifests').run();
  f.put(); f.put({ codec: 'hevc', width: 1920 }, f.entries[0], { ...identity, indexerBuild: 'b'.repeat(40) });
  const conflict = await f.read(f.url('codec=h264&minWidth=1920'));
  assert.equal(conflict.candidates[0].state, 'unknown'); assert.ok(conflict.candidates[0].evidence.every((e: any) => e.state === 'unknown' && e.reason === 'cached-stream-evidence-conflict'));
  f.db.prepare('UPDATE media_index_manifests SET metadata_json=NULL').run();
  assert.ok((await f.read(f.url('codec=hevc'))).candidates[0].evidence.every((e: any) => e.state === 'unknown'));
  f.db.prepare('DELETE FROM media_index_batches').run();
  f.db.prepare('UPDATE media_index_manifests SET schema_version=2').run();
  assert.ok((await f.read()).candidates[0].evidence.every((e: any) => e.state === 'unknown'));
});

test('FLV/TS use committed header geometry scope and never turn missing geometry or legacy storage into negatives', async t => {
  const f = await fixture(t), entry = f.entries[0], source = `${entry.id}@${entry.version}`;
  const flvDoc = { schema: 3, size: entry.size, codec: 'h264', description: [1, 100, 0, 31, 255, 224, 0], packets: [[40, 10, 0, 0, 1]] };
  f.library.frameIndexes.commit(entry.id, entry.version!, prepareFrameIndex(flvDoc, entry.size, flv, source, { scannedBytes: entry.size }), 0);
  const tsDoc = { schema: 2, kind: 'js-ts-packets', build: TS_PACKET_BUILD, sourceVersion: source, size: entry.size, streamKey: 'video:0', pid: 256, codec: 'h264', configuration: [1], completeness: { state: 'complete', packets: 1 },
    packets: [{ au: 0, locator: 0, pesOffset: 0, configuration: 0, timestamp: 0, ptsUs: 0, durationUs: 40000, size: 10, key: true, timing: { pts: 0, dts: null, timebase: [1, 90000], origin: 'pes' } }] };
  f.library.frameIndexes.commit(entry.id, entry.version!, prepareFrameIndex(tsDoc, entry.size, ts, source), 0);
  const ready = await f.read(f.url('codec=h264&recordsReady=1'));
  assert.equal(ready.candidates[0].state, 'match'); assert.equal(ready.candidates[0].evidence.length, 2);
  assert.ok(ready.candidates[0].evidence.every((e: any) => e.geometryScope === 'initial-codec-configuration'));
  const dimensions = await f.read(f.url('codec=hevc&minWidth=1'));
  assert.ok(dimensions.candidates[0].evidence.every((e: any) => e.state === 'unknown'), 'codec mismatch plus missing dimensions is not a known conjunction counterexample');
  f.db.prepare('UPDATE media_index_manifests SET packet_storage=NULL').run();
  assert.ok((await f.read(f.url('recordsReady=1'))).candidates[0].evidence.every((e: any) => e.state === 'unknown'));
  f.db.prepare("UPDATE media_index_manifests SET metadata_json=? WHERE kind='flv'").run(JSON.stringify({ codec: 'hevc' }));
  const conflict = (await f.read(f.url('codec=hevc'))).candidates[0].evidence.find((e: any) => e.identity.kind === 'flv');
  assert.equal(conflict.state, 'unknown'); assert.equal(conflict.reason, 'cached-identity-evidence-conflict');
});

test('bounded identity prefix and byte budgets never imply a complete inventory or hidden match', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) f.put({}, f.entries[0], { ...identity, indexerBuild: i.toString(16).padStart(40, '0') });
  const result = await f.read(f.url('codec=hevc&byteBudget=8192'));
  assert.equal(result.truncated, true); assert.equal(result.candidates[0].state, 'unknown'); assert.equal(result.nextCursor, null);
  assert.equal(result.work.projectionPasses, 2); assert.equal(result.work.identitiesInspected, 16); assert.equal(result.work.identitiesRead, 18);
  assert.ok(result.work.projectionReadBytes <= 18 * TECHNICAL_FILTER_LIMITS.projectionBytesPerIdentity);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  const tooMany = f.url() + Array.from({ length: 8 }, (_, i) => `&candidate=${i.toString(16).padStart(24, '0')}@${'a'.repeat(24)}`).join('');
  assert.equal((await fetch(tooMany)).status, 400);
});

test('different streams cannot supply separate halves of one technical conjunction', async t => {
  const f = await fixture(t); f.put();
  f.put({ codec: 'hevc', width: 1920, height: 1080 }, f.entries[0], { ...identity, streamKey: 'video:1' });
  const result = await f.read(f.url('codec=h264&minWidth=1280'));
  assert.equal(result.candidates[0].state, 'unknown');
  assert.deepEqual(result.candidates[0].evidence.map((e: any) => e.state), ['not-match', 'not-match']);
  assert.deepEqual(result.candidates[0].evidence.map((e: any) => e.identity.streamKey), ['video:0', 'video:1']);
});

test('evidence snapshot invalidates on same-connection replacement and other-connection writes, not only library revision', async t => {
  const f = await fixture(t); f.put();
  const q = f.query(), first = f.store.technicalFilter(q), revision = f.db.prepare('SELECT revision FROM library_revision').get()!.revision;
  assert.equal(f.store.technicalFilter(q, first.snapshot).snapshot, first.snapshot);
  assert.throws(() => new MediaIndexQueryStore(f.db).technicalFilter(q, first.snapshot), (e: any) => e.status === 409, 'a new worker cannot reuse the old verification token');
  f.put({}, f.entries[0], { ...identity, indexerBuild: 'b'.repeat(40) });
  assert.equal(f.db.prepare('SELECT revision FROM library_revision').get()!.revision, revision);
  assert.throws(() => f.store.technicalFilter(q, first.snapshot), (e: any) => e.status === 409);
  const second = f.store.technicalFilter(q);
  f.db.prepare('UPDATE media_index_manifests SET state=state').run();
  assert.throws(() => f.store.technicalFilter(q, second.snapshot), (e: any) => e.status === 409);
  const third = f.store.technicalFilter(q);
  f.db.prepare('DELETE FROM media_index_manifests').run();
  assert.throws(() => f.store.technicalFilter(q, third.snapshot), (e: any) => e.status === 409);
  f.put(); const fourth = f.store.technicalFilter(q);
  f.db.prepare('DELETE FROM media_index_manifests').run(); f.put();
  assert.throws(() => f.store.technicalFilter(q, fourth.snapshot), (e: any) => e.status === 409);
  assert.throws(() => f.store.technicalFilter({ ...q, filters: { codec: 'hevc' } }, f.store.technicalFilter(q).snapshot), (e: any) => e.status === 409);
  const token = new SharedArrayBuffer(4); Atomics.store(new Int32Array(token), 0, 1);
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  assert.throws(() => f.store.technicalFilter(q, undefined, token), (e: any) => e.status === 499);
  await assert.rejects(f.library.indexJobs.call('technical-filter', { query: q, cancellation: token }), (e: any) => e.status === 499);
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before);
});

test('HTTP revalidation detects replacement, source version change and unavailable sources', async t => {
  const f = await fixture(t); f.put();
  const call = f.library.indexJobs.call.bind(f.library.indexJobs);
  let replace = true;
  t.mock.method(f.library.indexJobs, 'call', async (op: any, ...args: any[]) => {
    const result = await (call as any)(op, ...args);
    if (op === 'technical-filter' && replace) { replace = false; f.put({}, f.entries[0], { ...identity, indexerBuild: 'b'.repeat(40) }); }
    return result;
  });
  const changed = await fetch(f.url()); assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'technical-evidence-changed');
  await rm(path.join(f.media, f.entries[0].name));
  const offlineCached = await f.read();
  assert.equal(offlineCached.candidates[0].availability, 'unavailable'); assert.equal(offlineCached.candidates[0].state, 'unknown');
  assert.ok(offlineCached.candidates[0].evidence.every((e: any) => e.state === 'unknown' && e.reason === 'source-unavailable'));
  const endpoint = f.url(); await writeFile(path.join(f.media, f.entries[0].name), 'replacement'); await f.library.refresh();
  assert.equal((await fetch(endpoint)).status, 409);
  const current = f.library.browse().entries;
  await rm(path.join(f.media, current[0].name));
  const offline = await f.read(f.url('codec=h264', current)); assert.equal(offline.candidates[0].availability, 'unavailable'); assert.equal(offline.candidates[0].state, 'unknown');
});

test('disconnect cancellation retains shared admission until all database work settles', { timeout: 15000 }, async t => {
  const f = await fixture(t); const tokens: SharedArrayBuffer[] = [];
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const original = f.library.indexJobs.call.bind(f.library.indexJobs);
  const mock = t.mock.method(f.library.indexJobs, 'call', async (op: any, data: any) => {
    if (op !== 'technical-filter') return (original as any)(op, data);
    tokens.push(data.cancellation); await pending; throw Object.assign(Error('cancelled'), { status: 499 });
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map(c => fetch(f.url(), { signal: c.signal }).catch(() => null));
  try {
    for (let i = 0; i < 500 && tokens.length < 8; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(tokens.length, 8);
    controllers.forEach(c => c.abort()); await Promise.all(requests);
    for (let i = 0; i < 500 && tokens.some(token => !Atomics.load(new Int32Array(token), 0)); i++) await nextTurn();
    assert.ok(tokens.every(token => Atomics.load(new Int32Array(token), 0)));
    const overflow = await fetch(f.base + `/api/media/${f.entries[0].id}/info?v=${f.entries[0].version}`);
    assert.equal(overflow.status, 503, 'cancelled filter still owns capacity shared with inventory queries');
  } finally { release(); await nextTurn(); mock.mock.restore(); }
  for (let i = 0; i < 500; i++) { const response = await fetch(f.url()); if (response.status !== 503) { assert.equal(response.status, 200); return; } await new Promise(r => setTimeout(r, 5)); }
  assert.fail('admission did not release after database work settled');
});
