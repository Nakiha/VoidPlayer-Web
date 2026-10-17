import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaLibraryIndex } from '../../server/library.ts';
import { request } from 'node:http';
import { AdminError } from '../../server/admin-error.ts';
import { AdminController } from '../../server/admin.ts';
import { loadConfig } from '../../server/config.ts';
import { createMediaServer } from '../../server/app.ts';
import { FFMPEG_INDEX_RECORD_BYTES, serializeFfmpegIndex } from '../../shared/media/indexing/ffmpeg-index-cache.ts';
import type { MediaIndexIdentity } from '../../shared/media/indexing/media-index-identity.ts';
import { syntheticFlv } from '../flv-fixture.ts';

const indexerBuild = 'a'.repeat(40);
const identity: MediaIndexIdentity = { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 3, indexerBuild };

function records(pts: number[]) {
  const bytes = new Uint8Array(pts.length * FFMPEG_INDEX_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pts.length; i++) {
    const offset = i * FFMPEG_INDEX_RECORD_BYTES;
    view.setBigInt64(offset, BigInt(pts[i]), true);
    view.setBigInt64(offset + 8, BigInt(pts[i] - 3_000), true);
    view.setBigInt64(offset + 16, 3_000n, true);
    view.setBigUint64(offset + 40, BigInt(i), true);
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
  const metadata = { schema: 3, kind: 'ffmpeg-container', size: bytes.length, codec: 'mpeg2video', timeBaseNum: 1,
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
  const untimed = records([0, 0]), untimedView = new DataView(untimed.buffer);
  for (let i = 0; i < 2; i++) {
    untimedView.setBigInt64(i * 48, -9223372036854775808n, true);
    untimedView.setBigInt64(i * 48 + 8, -9223372036854775808n, true);
    untimedView.setUint32(i * 48 + 36, 0, true);
    untimedView.setBigUint64(i * 48 + 40, BigInt(128 + i), true);
    library.frameIndexes.appendBuildBatch(entry.id, entry.version!, identity, epoch, completedBuildId, i + 1,
      Buffer.from(untimed.subarray(i * 48, (i + 1) * 48)).toString('base64'), 1, bytes.length, 4_233_333);
  }
  library.frameIndexes.finishBuild(entry.id, entry.version!, identity, epoch, completedBuildId, bytes.length, 4_233_333, 130);
  const reconstructed = JSON.parse(library.frameIndexes.getJson(entry.id, entry.version!, 'ffmpeg', identity));
  assert.deepEqual(Buffer.from(reconstructed.index.records, 'base64'), Buffer.concat([manyRecords, untimed]), 'batch base64 padding is reassembled safely');

  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: [media], library, admin, onLog() {} }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoint = `${base}/api/media/${entry.id}/frame-index?v=${entry.version}&kind=ffmpeg&stream=video%3A0&schema=3&indexer=${indexerBuild}`;
  try {
    const response = await fetch(endpoint, { headers: { accept: 'application/x-ndjson' } });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ['manifest', 'batch', 'batch', 'batch', 'complete']);
    assert.equal(events[0].protocol, 2);
    assert.equal(events[0].encoding, 'ffmpeg-records-base64');
    assert.equal(events[0].buildId, completedBuildId);
    assert.equal(events[1].seq, 0);
    assert.equal(events[1].count, 128);
    assert.equal(events[1].safePresentationUs, 4_233_333);
    assert.equal(Buffer.from(events[1].data, 'base64').byteLength, 128 * FFMPEG_INDEX_RECORD_BYTES);
    assert.equal(events.at(-1).frames, 130);
    assert.equal(events[2].safePresentationUs, 4_233_333);
    assert.equal(events[3].safePresentationUs, 4_233_333);

    const resumed = await fetch(endpoint + `&buildId=${completedBuildId}&after=0`, { headers: { accept: 'application/x-ndjson' } });
    const resumedEvents = (await resumed.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(resumedEvents.map(event => event.type), ['manifest', 'batch', 'batch', 'complete']);

    const tailResume = await fetch(endpoint + `&buildId=${completedBuildId}&after=1`, { headers: { accept: 'application/x-ndjson' } });
    const tailEvents = (await tailResume.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(tailEvents[1].safePresentationUs, 4_233_333, 'resume inside an untimed tail recovers finite watermark');
    const reset = await fetch(endpoint + '&buildId=22222222-2222-4222-8222-222222222222&after=0', { headers: { accept: 'application/x-ndjson' } });
    const resetEvents = (await reset.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(resetEvents.map(event => event.type), ['reset', 'manifest', 'batch', 'batch', 'batch', 'complete']);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await admin.close(); await library.close(); await rm(root, { recursive: true, force: true });
  }
});

test('frame-index HTTP failures finish before the deadline and release request resources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-index-http-errors-'));
  const media = path.join(root, 'media'); await mkdir(media); await mkdir(path.join(root, 'data'));
  await writeFile(path.join(media, 'clip.flv'), syntheticFlv());
  const library = new MediaLibraryIndex([media], { database: path.join(root, 'data', 'library.sqlite'), watch: false });
  await library.refresh();
  const entry = library.browse().entries[0];
  const logs: Record<string, unknown>[] = [];
  const server = createMediaServer({ roots: [media], library, onLog: value => logs.push(value) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoint = `${base}/api/media/${entry.id}/frame-index?v=${entry.version}`;
  const post = { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'frame-index', 'content-type': 'application/json' }, body: '{}' };
  async function response(url: string, init: RequestInit = {}) {
    const result = await fetch(url, { ...init, signal: AbortSignal.timeout(1500) });
    const body = await result.text(); // Includes the response end, not just headers.
    assert.ok(logs.at(-1)?.completed, 'HTTP finish was observed');
    return { result, body };
  }
  async function busy(url: string, init: RequestInit, message: string) {
    const { result, body } = await response(url, init);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('retry-after'), '1');
    assert.deepEqual(JSON.parse(body), { error: message, code: 'http-503' });
  }
  try {
    await t.test('upload concurrency limit returns a complete JSON 503', async () => {
      const release = [library.indexJobs.acquireUpload(), library.indexJobs.acquireUpload()];
      try { await busy(endpoint, post, '索引上传繁忙，请稍后重试。'); }
      finally { release.forEach(done => done()); }
    });
    await t.test('full build queue returns 503 before starting the stream', async () => {
      // Saturate the real queue admission check without starting unrelated media Workers.
      Reflect.set(library.indexJobs, 'activeBuilds', 1);
      Reflect.set(library.indexJobs, 'buildQueue', Array(8).fill(null));
      try {
        await busy(endpoint + `&kind=ffmpeg&stream=video%3A0&schema=3&indexer=${indexerBuild}&build=1`,
          { headers: { accept: 'application/x-ndjson' } }, '索引构建队列已满，请稍后重试。');
      } finally {
        Reflect.set(library.indexJobs, 'activeBuilds', 0);
        Reflect.set(library.indexJobs, 'buildQueue', []);
      }
    });
    await t.test('ordinary errors finish without Retry-After and release upload slots', async () => {
      const bad = await response(endpoint, { ...post, headers: { ...post.headers, 'content-type': 'text/plain' } });
      assert.equal(bad.result.status, 400);
      assert.equal(bad.result.headers.get('retry-after'), null);
      const mocked = t.mock.method(library.indexJobs, 'call', async () => { throw new Error('injected database failure'); });
      try {
        const failed = await response(endpoint, post);
        assert.equal(failed.result.status, 500);
        assert.deepEqual(JSON.parse(failed.body), { error: 'injected database failure' });
        assert.equal(failed.result.headers.get('retry-after'), null);
      } finally { mocked.mock.restore(); }
      const release = [library.indexJobs.acquireUpload(), library.indexJobs.acquireUpload()];
      release.forEach(done => done());
    });
    await t.test('post-header failure remains a terminated NDJSON error', async () => {
      const mocked = t.mock.method(library.indexJobs, 'buildIndex', async () => { throw new AdminError(503, 'injected build failure'); });
      try {
        const streamed = await response(endpoint + '&build=1', { headers: { accept: 'application/x-ndjson' } });
        assert.equal(streamed.result.status, 200);
        assert.equal(streamed.result.headers.get('retry-after'), null);
        assert.deepEqual(streamed.body.trim().split('\n').map(line => JSON.parse(line).type), ['manifest', 'error']);
      } finally { mocked.mock.restore(); }
    });
    await t.test('disconnected upload releases its slot and timer without a second response', async () => {
      let acquired!: () => void;
      const ready = new Promise<void>(resolve => { acquired = resolve; });
      const acquire = library.indexJobs.acquireUpload.bind(library.indexJobs);
      const mocked = t.mock.method(library.indexJobs, 'acquireUpload', () => { const release = acquire(); acquired(); return release; });
      const client = request(endpoint, { method: 'POST', headers: { ...post.headers, 'content-length': '100' } });
      client.on('error', () => {});
      try {
        client.write('{');
        let readinessTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, new Promise<never>((_, reject) => {
            readinessTimer = setTimeout(() => reject(new Error('upload slot was not acquired')), 1500);
          })]);
        } finally { clearTimeout(readinessTimer); }
        client.destroy();
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            if (Reflect.get(library.indexJobs, 'uploads') === 0) {
              clearInterval(poll); clearTimeout(deadline); resolve();
            }
          }, 5);
          const deadline = setTimeout(() => {
            clearInterval(poll); reject(new Error('upload abort was not released'));
          }, 1500);
        });
      } finally { client.destroy(); mocked.mock.restore(); }
    });
    await t.test('database deadline returns a complete 503 for JSON and NDJSON requests', async () => {
      const call = library.indexJobs.call.bind(library.indexJobs);
      const worker = Reflect.get(library.indexJobs, 'worker');
      // Suppress the database reply while exercising the real RPC deadline/cleanup.
      const stalled = t.mock.method(worker, 'postMessage', () => {});
      const mocked = t.mock.method(library.indexJobs, 'call', (...[op, ...args]: Parameters<typeof call>) => { args[2] = 10; return call(op, ...args); });
      try {
        await busy(endpoint, {}, '索引数据库操作超时，请稍后重试。');
        // Closed service is another pre-header 503, including an NDJSON request.
        assert.equal(Reflect.get(library.indexJobs, 'pending').size, 0);
        stalled.mock.restore();
        await library.indexJobs.close();
        await busy(endpoint, { headers: { accept: 'application/x-ndjson' } }, '索引服务已关闭。');
      } finally { mocked.mock.restore(); stalled.mock.restore(); }
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await library.close(); await rm(root, { recursive: true, force: true });
  }
});
