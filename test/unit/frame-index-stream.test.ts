import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../../server/library.ts';
import { AdminController } from '../../server/admin.ts';
import { loadConfig } from '../../server/config.ts';
import { createMediaServer } from '../../server/app.ts';
import { FFMPEG_INDEX_RECORD_BYTES, serializeFfmpegIndex } from '../../src/ffmpeg-index-cache.ts';
import type { MediaIndexIdentity } from '../../src/media-index-identity.ts';
import { syntheticFlv } from '.././flv-fixture.ts';

const indexerBuild = 'a'.repeat(40);
const identity: MediaIndexIdentity = { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 2, indexerBuild };

function records(pts: number[]) {
  const bytes = new Uint8Array(pts.length * FFMPEG_INDEX_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pts.length; i++) {
    const offset = i * FFMPEG_INDEX_RECORD_BYTES;
    view.setBigInt64(offset, BigInt(pts[i]), true);
    view.setBigInt64(offset + 8, BigInt(pts[i] - 3_000), true);
    view.setBigInt64(offset + 16, 3_000n, true);
    view.setBigInt64(offset + 24, BigInt(i * 188), true);
    view.setInt32(offset + 32, 188, true);
    view.setUint32(offset + 36, i === 0 ? 3 : 1, true);
  }
  return bytes;
}

test('FFmpeg record batches persist by identity and stream as NDJSON with build reset semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-frame-index-stream-'));
  const media = path.join(root, 'media'); await mkdir(media); await mkdir(path.join(root, 'data'));
  const bytes = syntheticFlv(); await writeFile(path.join(media, 'clip.ts'), bytes);
  const config = await loadConfig(['--folder', media], 'production', root); config.dataDir = path.join(root, 'data');
  const database = path.join(root, 'data', 'library.sqlite');
  const library = new MediaLibraryIndex([media], { database, watch: false }); await library.refresh();
  const entry = library.browse().entries[0];
  const recordBytes = records([90_000, 93_000, 96_000]);
  const document = serializeFfmpegIndex({ size: bytes.length, codec: 'mpeg2video', timeBaseNum: 1, timeBaseDen: 90_000,
    width: 1920, height: 1080, streamIndex: 0, indexerBuild, firstPts: '90000', originVerified: true }, recordBytes);
  const epoch = library.frameIndexes.epoch;
  const buildId = '11111111-1111-4111-8111-111111111111';
  const metadata = { schema: 2, kind: 'ffmpeg-container', size: bytes.length, codec: 'mpeg2video', timeBaseNum: 1,
    timeBaseDen: 90_000, width: 1920, height: 1080, recordBytes: FFMPEG_INDEX_RECORD_BYTES, streamIndex: 0,
    indexerBuild, firstPts: '90000', originVerified: true };
  library.frameIndexes.beginBuild(entry.id, entry.version!, identity, epoch, buildId, metadata);
  library.frameIndexes.updateBuildProgress(entry.id, entry.version!, identity, buildId, 100, 188);
  const first = recordBytes.subarray(0, FFMPEG_INDEX_RECORD_BYTES);
  library.frameIndexes.appendBuildBatch(entry.id, entry.version!, identity, epoch, buildId, 0,
    Buffer.from(first).toString('base64'), 1, 188, 0);
  const partial = library.frameIndexes.streamManifest(entry.id, entry.version!, identity);
  assert.equal(partial.manifest?.buildId, buildId);
  assert.equal(partial.manifest?.state, 'streaming');
  assert.equal(partial.manifest?.packets, 100);
  assert.equal(partial.manifest?.scannedBytes, 188);
  assert.equal(partial.manifest?.lastSeq, 0);
  assert.equal((library.frameIndexes.streamBatches(entry.id, entry.version!, identity, -1, 16) as any[]).length, 1);
  library.frameIndexes.failBuild(entry.id, entry.version!, identity, buildId);
  assert.equal(library.frameIndexes.streamManifest(entry.id, entry.version!, identity).manifest?.state, 'failed');

  library.frameIndexes.put(entry.id, entry.version!, entry.size, document, epoch, identity);
  assert.deepEqual(library.frameIndexes.get(entry.id, entry.version!).index, null, 'FLV identity remains separate from FFmpeg identity');
  const full = JSON.parse(library.frameIndexes.getJson(entry.id, entry.version!, 'ffmpeg', identity));
  assert.deepEqual(full.index, document);
  const manyRecords = records(Array.from({ length: 128 }, (_, i) => 90_000 + i * 3_000));
  const completedBuildId = '33333333-3333-4333-8333-333333333333';
  library.frameIndexes.beginBuild(entry.id, entry.version!, identity, epoch, completedBuildId, metadata);
  library.frameIndexes.appendBuildBatch(entry.id, entry.version!, identity, epoch, completedBuildId, 0,
    Buffer.from(manyRecords).toString('base64'), 128, 4096, 4_233_333);
  library.frameIndexes.finishBuild(entry.id, entry.version!, identity, epoch, completedBuildId, bytes.length, 4_233_333, 128);
  const reconstructed = JSON.parse(library.frameIndexes.getJson(entry.id, entry.version!, 'ffmpeg', identity));
  assert.deepEqual(Buffer.from(reconstructed.index.records, 'base64'), Buffer.from(manyRecords), 'batch base64 padding is reassembled safely');

  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: [media], library, admin, onLog() {} }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoint = `${base}/api/media/${entry.id}/frame-index?v=${entry.version}&kind=ffmpeg&stream=video%3A0&schema=2&indexer=${indexerBuild}`;
  try {
    const response = await fetch(endpoint, { headers: { accept: 'application/x-ndjson' } });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ['manifest', 'batch', 'complete']);
    assert.equal(events[0].protocol, 2);
    assert.equal(events[0].encoding, 'ffmpeg-records-base64');
    assert.equal(events[0].buildId, completedBuildId);
    assert.equal(events[1].seq, 0);
    assert.equal(events[1].count, 128);
    assert.equal(events[1].safePresentationUs, 4_233_333);
    assert.equal(Buffer.from(events[1].data, 'base64').byteLength, 128 * FFMPEG_INDEX_RECORD_BYTES);
    assert.equal(events[2].frames, 128);

    const resumed = await fetch(endpoint + `&buildId=${completedBuildId}&after=0`, { headers: { accept: 'application/x-ndjson' } });
    const resumedEvents = (await resumed.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(resumedEvents.map(event => event.type), ['manifest', 'complete']);

    const reset = await fetch(endpoint + '&buildId=22222222-2222-4222-8222-222222222222&after=0', { headers: { accept: 'application/x-ndjson' } });
    const resetEvents = (await reset.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(resetEvents.map(event => event.type), ['reset', 'manifest', 'batch', 'complete']);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await admin.close(); await library.close(); await rm(root, { recursive: true, force: true });
  }
});
