import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../server/library.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex } from '../src/flv-index-cache.ts';
import { syntheticFlv } from './flv-fixture.ts';

test('worker admission, final epoch/media checks and encoded GET keep stale tasks from repopulating caches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-index-worker-')); await mkdir(path.join(root, 'media'));
  const bytes = syntheticFlv(), file = path.join(root, 'media', 'one.flv'); await writeFile(file, bytes);
  const library = new MediaLibraryIndex([path.join(root, 'media')], { watch: false });
  try {
    await library.refresh(); let entry = library.browse().entries[0];
    const reader = new FlvReader({ file: new Blob([bytes]) });
    const index = serializeFlvIndex(await demuxFlv(reader), bytes.length); reader.close();
    const release = library.indexJobs.acquire();
    assert.throws(() => library.indexJobs.acquire(), /繁忙/);
    const prepare = async (epoch: number) => {
      const body = new TextEncoder().encode(JSON.stringify({ epoch, index }));
      return library.indexJobs.call('prepare', { bytes: body, size: entry.size }, [body.buffer]);
    };
    await prepare(0); library.frameIndexes.remove();
    await assert.rejects(library.indexJobs.call('commit', { id: entry.id, version: entry.version, epoch: 0 }), /清理/);
    assert.equal(library.frameIndexes.list().count, 0);
    await prepare(1);
    await writeFile(file, Buffer.concat([bytes, Buffer.from([0])])); await library.refresh();
    await assert.rejects(library.indexJobs.call('commit', { id: entry.id, version: entry.version, epoch: 1 }), /改变/);
    await writeFile(file, bytes); await library.refresh(); entry = library.browse().entries[0];
    await prepare(1); await library.indexJobs.call('commit', { id: entry.id, version: entry.version, epoch: 1 });
    const encoded = await library.indexJobs.call('get', { id: entry.id, version: entry.version });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), { epoch: 1, index });
    release(); const again = library.indexJobs.acquire(); again();
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});


test('worker stores and returns versioned FFmpeg binary indexes through the shared cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-ffmpeg-index-worker-'));
  const mediaRoot = path.join(root, 'media');
  await mkdir(mediaRoot);
  const file = path.join(mediaRoot, 'one.ts');
  await writeFile(file, Buffer.from([0, 0, 1, 0x47]));
  const library = new MediaLibraryIndex([mediaRoot], { watch: false });
  try {
    await library.refresh();
    const entry = library.browse().entries[0];
    const records = Buffer.alloc(48);
    records.writeBigInt64LE(10n, 0); records.writeBigInt64LE(3000n, 8); records.writeUInt32LE(1, 16);
    records.writeBigInt64LE(20n, 24); records.writeBigInt64LE(3000n, 32);
    const document = {
      schema: 1, kind: 'ffmpeg-container', size: entry.size, codec: 'mpeg2video',
      timeBaseNum: 1, timeBaseDen: 90000, width: 1280, height: 720,
      recordBytes: 24, count: 2, records: records.toString('base64'),
    };
    const body = new TextEncoder().encode(JSON.stringify({ epoch: 0, index: document }));
    await library.indexJobs.call('prepare', { bytes: body, size: entry.size, kind: 'ffmpeg' }, [body.buffer]);
    await library.indexJobs.call('commit', { id: entry.id, version: entry.version, epoch: 0 });
    const encoded = await library.indexJobs.call('get', { id: entry.id, version: entry.version, kind: 'ffmpeg' });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), { epoch: 0, index: document });
    assert.equal(library.frameIndexes.has(entry.id, entry.version!, 'ffmpeg'), true);
    assert.equal(library.frameIndexes.has(entry.id, entry.version!, 'flv'), false);
  } finally { await library.close(); await rm(root, { recursive: true, force: true }); }
});
