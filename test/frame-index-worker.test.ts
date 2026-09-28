import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../server/library.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex } from '../src/flv-index-cache.ts';
import { syntheticFlv } from './flv-fixture.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../src/media-index-identity.ts';

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
    const records = Buffer.alloc(80);
    records.writeBigInt64LE(10n, 0); records.writeBigInt64LE(9n, 8); records.writeBigInt64LE(3000n, 16);
    records.writeBigInt64LE(0n, 24); records.writeInt32LE(100, 32); records.writeUInt32LE(3, 36);
    records.writeBigInt64LE(20n, 40); records.writeBigInt64LE(19n, 48); records.writeBigInt64LE(3000n, 56);
    records.writeBigInt64LE(-1n, 64); records.writeInt32LE(50, 72); records.writeUInt32LE(0, 76);
    const ffmpegIdentity = { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 2, indexerBuild: 'a'.repeat(40) };
    const ffmpegDocument = {
      schema: 2, kind: 'ffmpeg-container', size: entry.size, codec: 'mpeg2video',
      timeBaseNum: 1, timeBaseDen: 90000, width: 1280, height: 720,
      streamIndex: 0, indexerBuild: ffmpegIdentity.indexerBuild,
      recordBytes: 40, count: 2, firstPts: '10', originVerified: false, records: records.toString('base64'),
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
