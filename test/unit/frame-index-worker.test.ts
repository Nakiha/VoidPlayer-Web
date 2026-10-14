import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../../server/library.ts';
import { demuxFlv, FlvReader } from '../../src/flv-demux.ts';
import { serializeFlvIndex } from '../../src/flv-index-cache.ts';
import { syntheticFlv } from '.././flv-fixture.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../../src/media-index-identity.ts';

test('identity-aware cache RPC checks media version and clear epoch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-index-worker-')); await mkdir(path.join(root, 'media'));
  const bytes = syntheticFlv(), file = path.join(root, 'media', 'one.flv'); await writeFile(file, bytes);
  const library = new MediaLibraryIndex([path.join(root, 'media')], { watch: false });
  try {
    await library.refresh(); let entry = library.browse().entries[0];
    const reader = new FlvReader({ file: new Blob([bytes]) });
    const index = serializeFlvIndex(await demuxFlv(reader), bytes.length); reader.close();
    const put = async (epoch: number, target = entry, value: unknown = index) => {
      const body = new TextEncoder().encode(JSON.stringify({ epoch, index: value }));
      return library.indexJobs.call('put', {
        id: target.id, version: target.version, size: target.size, identity: FLV_MEDIA_INDEX_IDENTITY, bytes: body,
      }, [body.buffer]);
    };
    await put(0);
    library.frameIndexes.remove();
    await assert.rejects(put(0), /清理/);
    assert.equal(library.frameIndexes.list().count, 0);
    await writeFile(file, Buffer.concat([bytes, Buffer.from([0])])); await library.refresh();
    await assert.rejects(put(1, entry), /改变/);
    await writeFile(file, bytes); await library.refresh(); entry = library.browse().entries[0];
    await put(1);
    const [encoded, present, epoch] = await Promise.all([
      library.indexJobs.call('get', { id: entry.id, version: entry.version, identity: FLV_MEDIA_INDEX_IDENTITY }),
      library.indexJobs.call('has', { id: entry.id, version: entry.version, identity: FLV_MEDIA_INDEX_IDENTITY }),
      library.indexJobs.call('epoch'),
    ]);
    assert.equal(present, true);
    assert.equal(epoch, 1);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded as Uint8Array)), { epoch: 1, index });
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});


test('manifest identity keeps FLV and FFmpeg payloads separate for one media version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-ffmpeg-index-worker-'));
  const mediaRoot = path.join(root, 'media');
  await mkdir(mediaRoot);
  const file = path.join(mediaRoot, 'one.flv'), media = syntheticFlv();
  await writeFile(file, media);
  const library = new MediaLibraryIndex([mediaRoot], { watch: false });
  try {
    await library.refresh();
    const entry = library.browse().entries[0];
    const records = Buffer.alloc(96);
    records.writeBigInt64LE(10n, 0); records.writeBigInt64LE(9n, 8); records.writeBigInt64LE(3000n, 16);
    records.writeBigInt64LE(0n, 24); records.writeInt32LE(100, 32); records.writeUInt32LE(3, 36);
    records.writeBigInt64LE(20n, 48); records.writeBigInt64LE(19n, 56); records.writeBigInt64LE(3000n, 64);
    records.writeBigInt64LE(-1n, 72); records.writeInt32LE(50, 80); records.writeUInt32LE(0, 84);
    records.writeBigUInt64LE(0n, 40); records.writeBigUInt64LE(1n, 88);
    const ffmpegIdentity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild: 'a'.repeat(40) };
    const ffmpegDocument = {
      schema: 3, kind: 'ffmpeg-container', size: entry.size, codec: 'mpeg2video',
      timeBaseNum: 1, timeBaseDen: 90000, width: 1280, height: 720,
      streamIndex: 0, indexerBuild: ffmpegIdentity.indexerBuild,
      recordBytes: 48, count: 2, firstPts: '10', originVerified: false, records: records.toString('base64'),
    };
    const flvReader = new FlvReader({ file: new Blob([media]) });
    const flvDocument = serializeFlvIndex(await demuxFlv(flvReader), media.length); flvReader.close();
    const put = async (identity: typeof ffmpegIdentity | typeof FLV_MEDIA_INDEX_IDENTITY, document: unknown) => {
      const body = new TextEncoder().encode(JSON.stringify({ epoch: 0, index: document }));
      await library.indexJobs.call('put', {
        id: entry.id, version: entry.version, size: entry.size, identity, bytes: body,
      }, [body.buffer]);
    };
    await put(ffmpegIdentity, ffmpegDocument);
    await put(FLV_MEDIA_INDEX_IDENTITY, flvDocument);
    const encoded = await library.indexJobs.call('get', {
      id: entry.id, version: entry.version, identity: ffmpegIdentity,
    });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded as Uint8Array)), { epoch: 0, index: ffmpegDocument });
    assert.equal(library.frameIndexes.has(entry.id, entry.version!, 'ffmpeg', ffmpegIdentity), true);
    assert.equal(library.frameIndexes.has(entry.id, entry.version!, 'flv'), true);
    assert.equal(library.frameIndexes.list().count, 2);
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});

test('database Worker messageerror rejects every pending RPC and isolates late events from recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-db-messageerror-'));
  const library = new MediaLibraryIndex([], { database: path.join(root, 'index.sqlite'), watch: false });
  const jobs = library.indexJobs;
  try {
    const first = jobs.call('epoch').then(() => null, error => error as Error);
    const second = jobs.call('epoch').then(() => null, error => error as Error);
    const worker = (jobs as any).worker as import('node:worker_threads').Worker;
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.emit('messageerror', new Error('injected invalid database reply'));
    assert.equal((jobs as any).worker, undefined);
    assert.equal((jobs as any).pending.size, 0);
    const recovery = jobs.call('epoch');
    const next = (jobs as any).worker;
    assert.notEqual(next, worker);
    // The old worker is still terminating; its event cannot reject the new
    // generation's pending request or replace its database owner.
    worker.emit('messageerror', new Error('late old database reply'));
    assert.equal((jobs as any).worker, next);
    assert.equal(await recovery, 0);
    for (const error of await Promise.all([first, second])) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /消息无法反序列化/);
    }
    await exited;
    assert.equal((jobs as any).pending.size, 0);
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});

test('build Worker messageerror rejects joined demand and releases the queued independent build', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-build-messageerror-'));
  const mediaRoot = path.join(root, 'media'); await mkdir(mediaRoot);
  const bytes = syntheticFlv(), filePath = path.join(mediaRoot, 'one.flv'), queuedPath = path.join(mediaRoot, 'two.flv');
  await writeFile(filePath, bytes); await writeFile(queuedPath, bytes);
  const library = new MediaLibraryIndex([mediaRoot], { watch: false });
  try {
    await library.refresh();
    const entries = library.browse().entries, entry = entries.find(item => item.name === 'one.flv')!, queuedEntry = entries.find(item => item.name === 'two.flv')!, jobs = library.indexJobs;
    assert.ok(entry.version); assert.ok(queuedEntry.version);
    const epoch = await jobs.call('epoch') as number;
    const request = { id: entry.id, version: entry.version, size: entry.size, filePath, epoch, identity: FLV_MEDIA_INDEX_IDENTITY };
    const active = jobs.startBuild(request), joined = jobs.startBuild(request);
    assert.equal(active.promise, joined.promise);
    const rejected = active.promise.then(() => null, error => error as Error);
    const worker = [...(jobs as any).buildWorkers][0] as import('node:worker_threads').Worker;
    assert.ok(worker);
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    const queued = jobs.startBuild({ ...request, id: queuedEntry.id, version: queuedEntry.version, size: queuedEntry.size, filePath: queuedPath });
    const queuedResult = queued.promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
    assert.equal((jobs as any).buildQueue.length, 1);
    worker.emit('messageerror', new Error('injected invalid build reply'));
    assert.equal((jobs as any).buildWorkers.has(worker), false);
    const error = await rejected; assert.ok(error instanceof Error); assert.match(error.message, /消息无法反序列化/);
    const result = await queuedResult; assert.equal(result.error, undefined); assert.equal(result.value.built, true);
    await exited;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((jobs as any).activeBuilds, 0);
    assert.equal((jobs as any).buildQueue.length, 0);
    assert.equal((jobs as any).buildWorkers.size, 0);
    assert.equal((jobs as any).builds.size, 0);
    // The failed deduplication key must be reusable, not a poisoned promise.
    assert.equal((await jobs.startBuild(request).promise).built, true);
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});
