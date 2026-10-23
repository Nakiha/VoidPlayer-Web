import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { FFMPEG_NO_TIMESTAMP, ffmpegTicksToUs } from '../../shared/media/indexing/ffmpeg-index-cache.ts';
import { semanticRecord, recordMatches, parseSemanticQuery } from '../../shared/media/indexing/semantic-query.ts';

const identity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild: 'a'.repeat(40) };
const selection = new URLSearchParams({ kind: identity.kind, stream: identity.streamKey, schema: '3', indexer: identity.indexerBuild }).toString();
function recordBytes(count: number, start = 0, untimed = false) {
  const bytes = Buffer.alloc(count * 48);
  for (let i = 0; i < count; i++) {
    const offset = i * 48, n = i + start;
    bytes.writeBigInt64LE(untimed && i === count - 1 ? FFMPEG_NO_TIMESTAMP : BigInt(n * 40), offset);
    bytes.writeBigInt64LE(untimed && i === count - 1 ? FFMPEG_NO_TIMESTAMP : BigInt(n * 40 - 40), offset + 8);
    bytes.writeBigInt64LE(40n, offset + 16); bytes.writeBigInt64LE(-1n, offset + 24);
    bytes.writeInt32LE(100 + n, offset + 32); bytes.writeUInt32LE(n % 10 ? 0 : 1, offset + 36);
    bytes.writeBigUInt64LE(BigInt(n), offset + 40);
  }
  return bytes;
}
const metadata = (size: number) => ({ schema: 3, kind: 'ffmpeg-container', size, codec: 'h264', width: 640, height: 360,
  timeBaseNum: 1, timeBaseDen: 1000, streamIndex: 0, indexerBuild: identity.indexerBuild,
  recordBytes: 48, firstPts: '0', originVerified: true });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vp-media-query-')), media = path.join(dir, 'media'), database = path.join(dir, 'index.sqlite');
  await mkdir(media); await writeFile(path.join(media, 'clip.mp4'), Buffer.alloc(10000));
  const library = new MediaLibraryIndex([media], { database, watch: false });
  await library.refresh(); const entry = library.browse().entries[0];
  const server = createMediaServer({ roots: [media], library, onLog() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const db = openIndexDatabase(database);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await library.close(); await rm(dir, { recursive: true, force: true }); });
  const endpoint = `${base}/api/media/${entry.id}/index-query?v=${entry.version}&${selection}`;
  const info = `${base}/api/media/${entry.id}/info?v=${entry.version}`;
  const put = (count = 3, extra = {}, untimed = false) => library.frameIndexes.put(entry.id, entry.version!, entry.size,
    { ...metadata(entry.size), count, records: recordBytes(count, 0, untimed).toString('base64'), indexIntegrity: 'complete', ...extra }, library.frameIndexes.epoch, identity);
  const read = async (url = endpoint) => { const res = await fetch(url); const body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); return body; };
  return { dir, media, library, entry, db, base, endpoint, info, put, read };
}

test('shared query preserves 64-bit timestamps, missing values, reorder and half-open ranges', () => {
  const bytes = recordBytes(2), huge = 9007199254740993n;
  bytes.writeBigInt64LE(huge, 0); bytes.writeBigInt64LE(huge - 2n, 8); bytes.writeBigUInt64LE(1n, 40);
  bytes.writeBigInt64LE(FFMPEG_NO_TIMESTAMP, 48); bytes.writeBigInt64LE(FFMPEG_NO_TIMESTAMP, 56); bytes.writeBigInt64LE(0n, 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), clock = { num: 1, den: 90000, firstPts: (huge - 3n).toString(), originVerified: true };
  const r = semanticRecord(view, 0, clock);
  assert.equal(r.ptsTick, huge.toString()); assert.equal(r.dtsTick, (huge - 2n).toString());
  assert.equal(r.normalizedPtsUs, String(ffmpegTicksToUs(3n, 1, 90000))); assert.equal(r.decodeOrdinal, '1');
  assert.equal(r.randomAccessVerified, null); assert.equal(r.pictureType, null); assert.equal(r.qp, null);
  const unknown = semanticRecord(view, 48, clock); assert.equal(unknown.ptsTick, null); assert.equal(unknown.dtsTick, null); assert.equal(unknown.durationTick, null); assert.equal(unknown.normalizedPtsUs, null);
  assert.equal(semanticRecord(view, 0, { ...clock, originVerified: false }).normalizedPtsUs, null);
  const q = parseSemanticQuery(new URLSearchParams({ startTick: huge.toString(), endTick: (huge + 1n).toString() }));
  assert.equal(recordMatches(r, q), true); assert.equal(recordMatches(r, { ...q, endTick: huge.toString() }), false); assert.equal(recordMatches(unknown, q), null);
  for (const params of ['startTick=0&endTick=1&limit=0', 'startTick=1&endTick=1', 'startTick=0&endTick=9223372036854775808', 'startTick=0&endTick=1&axis=frame', 'startTick=0&endTick=1&byteBudget=999999']) assert.throws(() => parseSemanticQuery(new URLSearchParams(params)));
});

test('headless discovery/search/info/cache misses never build, migrate, mutate or disclose paths', async t => {
  const f = await fixture(t);
  f.library.refresh = async () => { throw Error('unexpected scan'); };
  f.library.indexJobs.startBuild = () => { throw Error('unexpected build'); };
  const manifest = await f.read(f.base + '/api/agent');
  assert.equal(manifest.capabilities.find((c: { id: string }) => c.id === 'media.cached-index-query').readiness, 'per-source');
  assert.equal(manifest.capabilities.find((c: { id: string }) => c.id === 'media.technical-filter').implemented, false);
  const search = await f.read(f.base + '/api/library/browse?recursive=1&search=clip&limit=1'); assert.equal(search.entries[0].id, f.entry.id);
  const info = await f.read(f.info); assert.equal(info.technicalState, 'not-probed'); assert.deepEqual(info.indexes, []);
  const missing = await f.read(); assert.equal(missing.overview.state, 'not-indexed'); assert.equal(missing.overview.capabilities.records.ready, false);
  assert.equal(missing.overview.technical.bitDepth.value, null); assert.equal(missing.overview.technical.bitDepth.status, 'not-probed');
  const schema = await f.read(f.base + missing.describedBy); assert.match(schema.recordGranularity, /not guaranteed/); assert.match(schema.fields.containerKey, /not proof/);
  assert.equal(JSON.stringify([info, missing, manifest]).includes(f.dir), false);
  const head = await fetch(f.info, { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(JSON.stringify(info)));
  assert.equal((await fetch(f.info, { method: 'POST' })).status, 405);
  for (const suffix of ['&build=1', '&v=' + f.entry.version, '&unknown=1']) assert.equal((await fetch(f.endpoint + suffix)).status, 400);
  const badVersion = await fetch(f.info.replace(f.entry.version!, 'b'.repeat(24))); assert.equal(badVersion.status, 409); assert.equal((await badVersion.json()).code, 'media-version-changed');
  assert.equal(f.library.frameIndexes.list().count, 0);
  f.put();
  // Legacy caches must remain untouched: overview must not call streamManifest's migration path.
  f.db.prepare('UPDATE media_index_manifests SET metadata_json=NULL').run();
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  assert.equal((await f.read()).overview.state, 'unknown');
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before);
});

test('semantic pages obey response/work budgets, cursors, half-open PTS/DTS and untimed accounting', async t => {
  const f = await fixture(t); f.put(3001, {}, true);
  const overview = await f.read(); assert.equal(overview.overview.state, 'complete'); assert.equal(overview.overview.technical.codec.value, 'h264');
  assert.equal(overview.overview.technical.frameRateMode.value, null); assert.equal(overview.overview.stablePresentationUs, null);
  const url = f.endpoint + '&view=records&startTick=40&endTick=120&limit=1';
  const first = await f.read(url); assert.equal(first.records[0].ptsTick, '40'); assert.equal(first.summary.sumBytes, 101); assert.ok(first.nextCursor);
  const second = await f.read(url + '&cursor=' + first.nextCursor); assert.equal(second.records[0].ptsTick, '80'); assert.equal(second.summary.count, 1);
  let page = await f.read(url + '&cursor=' + second.nextCursor); assert.equal(page.records.length, 0); assert.equal(page.inspected, 2048); assert.equal(page.exhausted, false);
  page = await f.read(url + '&cursor=' + page.nextCursor); assert.equal(page.exhausted, true); assert.equal(page.inspectedUntimed, 1);
  const dts = await f.read(f.endpoint + '&view=records&axis=dts&startTick=-40&endTick=0'); assert.equal(dts.records.length, 1); assert.equal(dts.records[0].ptsTick, '0');
  const bounded = await fetch(f.endpoint + '&view=records&startTick=0&endTick=999999&limit=256&byteBudget=8192'); const bytes = await bounded.text();
  assert.equal(bounded.status, 200, bytes); assert.ok(Buffer.byteLength(bytes) <= 8192); assert.ok(JSON.parse(bytes).records.length > 0); assert.ok(JSON.parse(bytes).records.length < 256);
  const changedRange = await fetch(url.replace('endTick=120', 'endTick=121') + '&cursor=' + first.nextCursor); assert.equal(changedRange.status, 409);
  f.library.frameIndexes.remove(); assert.equal((await fetch(url + '&cursor=' + first.nextCursor)).status, 409);
});

test('partial, failed, retained-prefix and unknown integrity stay distinct from complete coverage', async t => {
  const f = await fixture(t), buildId = '11111111-1111-4111-8111-111111111111';
  f.library.frameIndexes.beginBuild(f.entry.id, f.entry.version!, identity, 0, buildId, metadata(f.entry.size));
  assert.equal((await f.read()).overview.state, 'partial');
  const records = recordBytes(2);
  f.library.frameIndexes.appendBuildBatch(f.entry.id, f.entry.version!, identity, 0, buildId, 0, records.toString('base64'), 2, 100, 40000);
  const url = f.endpoint + '&view=records&startTick=-100&endTick=200&limit=1';
  const first = await f.read(url); assert.equal(first.overview.terminal, false); assert.equal(first.overview.stablePresentationUs, '40000');
  f.library.frameIndexes.failBuild(f.entry.id, f.entry.version!, identity, buildId);
  assert.equal((await f.read()).overview.reason, 'build-failed'); assert.equal((await fetch(url + '&cursor=' + first.nextCursor)).status, 409);
  f.library.frameIndexes.remove(); f.put(3, { indexIntegrity: 'prefix', indexTruncatedAt: 9999, indexEndDts: '40' });
  const prefix = await f.read(); assert.equal(prefix.overview.terminal, true); assert.equal(prefix.overview.state, 'partial'); assert.equal(prefix.overview.reason, 'retained-prefix');
  f.library.frameIndexes.remove(); f.put(3, { indexIntegrity: undefined });
  assert.equal((await f.read()).overview.reason, 'integrity-unknown');
});

test('oversized cache batches are rejected without expansion; file and symlink boundaries fail closed', async t => {
  const f = await fixture(t); f.put(3000);
  // Persist as one large batch to exercise substr reads, not a pre-split test artifact.
  f.db.prepare('DELETE FROM media_index_batches WHERE seq>0').run();
  f.db.prepare('UPDATE media_index_batches SET payload=?,frames=3000,bytes=? WHERE seq=0').run(recordBytes(3000).toString('base64'), 3000 * 64);
  f.db.prepare('UPDATE media_index_manifests SET last_seq=0').run();
  const before = f.db.prepare('SELECT * FROM media_index_manifests').all();
  const denied = await fetch(f.endpoint + '&view=records&startTick=999999&endTick=1000000'); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'index-cache-invalid');
  assert.deepEqual(f.db.prepare('SELECT * FROM media_index_manifests').all(), before);
  await rename(path.join(f.media, 'clip.mp4'), path.join(f.media, 'saved'));
  const offline = await fetch(f.info); assert.equal(offline.status, 409); assert.equal((await offline.json()).code, 'media-unavailable');
  await writeFile(path.join(f.media, 'clip.mp4'), 'replacement'); assert.equal((await fetch(f.info)).status, 409);
  await rm(path.join(f.media, 'clip.mp4'));
  if (process.platform !== 'win32') { await writeFile(path.join(f.dir, 'outside'), Buffer.alloc(10000)); await symlink(path.join(f.dir, 'outside'), path.join(f.media, 'clip.mp4')); }
  assert.equal((await fetch(f.info)).status, 409);
});


test('cache query admission rejects excess in-flight work with retryable feedback', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.library.indexJobs.call('cached-indexes', { id: f.entry.id, version: f.entry.version!, offset: 0 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  const rejected = results.filter(result => result.status === 'rejected'); assert.equal(rejected.length, 4);
  for (const result of rejected) { assert.equal(result.reason.status, 503); assert.equal(result.reason.code, 'media-query-busy'); }
  assert.equal((await f.read(f.info)).technicalState, 'not-probed');
});
