import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MediaLibraryIndex } from '../../server/library.ts';
import { instantiateCore } from '../../src/wasm-core.ts';
import { createMediaServer } from '../../server/app.ts';
import { openFFmpegMedia, openFFmpegContainerFromUrl } from '../../src/ffmpeg-media.ts';

test('cold and warm server corruption prefixes import the same decode boundary and exact seek pixels', { timeout: 60000 }, async () => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  const deps = { glueURL: pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href,
    wasmBinary: await readFile(path.join(coreDir, 'voidplayer-core.wasm')) };
  const bytes = await readFile('fixtures/video/mpeg2_10s_1280x720.ts');
  const damaged = Buffer.concat([bytes, Buffer.alloc(190 * 1024, 0xa5)]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-damaged-index-'));
  await writeFile(path.join(root, 'damaged.ts'), damaged);
  const library = new MediaLibraryIndex([root], { watch: false });
  const server = createMediaServer({ roots: [root], library, onLog() {} });
  const original = await openFFmpegMedia(new File([bytes], 'original.ts'), deps);
  try {
    await library.refresh();
    const entry = library.browse().entries[0];
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/media/${entry.id}?v=${entry.version}`;
    let boundary: number | undefined, duration: number | undefined;
    for (const phase of ['cold', 'warm']) {
      const source = await openFFmpegContainerFromUrl(url, { name: 'damaged.ts', size: damaged.length, lastModified: 0 }, deps);
      try {
        await source.ensureIndexed?.();
        assert.equal(source.info.indexSource, 'server');
        assert.equal(source.info.indexState, 'complete');
        assert.equal(source.info.indexIntegrity, 'prefix');
        assert.match(source.info.indexWarning!, /有效前段/);
        assert.ok(source.info.indexTruncatedAt! < bytes.length);
        boundary ??= source.info.indexTruncatedAt; duration ??= source.info.durationUs;
        assert.equal(source.info.indexTruncatedAt, boundary, `${phase} retains the same file boundary`);
        assert.equal(source.info.durationUs, duration);
        for (const time of [source.info.durationUs - 1, 0, Math.floor(source.info.durationUs / 2), source.info.durationUs - 1]) {
          const expected = await original.frameAt(time), actual = await source.frameAt(time);
          try {
            assert.equal(actual.ptsUs, expected.ptsUs);
            assert.equal(createHash('sha256').update(actual.pixels!).digest('hex'), createHash('sha256').update(expected.pixels!).digest('hex'));
          } finally { expected.close(); actual.close(); }
        }
        assert.deepEqual(await source.framesAfter(source.info.durationUs, 1), []);
      } finally { source.dispose(); }
    }
  } finally {
    original.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await library.close(); await rm(root, { recursive: true, force: true });
  }
});

test('cold server index build returns AVIO, scan, storage and CPU profile counters', async t => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  if (!existsSync(path.join(coreDir, 'voidplayer-core.js')) || !existsSync(path.join(coreDir, 'voidplayer-core.wasm'))) {
    t.skip('WASM core is not synced');
    return;
  }

  const wasm = new Uint8Array(await readFile(path.join(coreDir, 'voidplayer-core.wasm')));
  const glue = await import(pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href);
  const { core } = await instantiateCore(glue.default, wasm);
  const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []) as string;
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-frame-index-profile-'));
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir);
  const filePath = path.join(mediaDir, 'sample.ts');
  await copyFile(path.resolve('fixtures/fate/mpegts--h264small.ts'), filePath);
  const library = new MediaLibraryIndex([mediaDir], { watch: false });
  try {
    await library.refresh();
    const entry = library.browse().entries[0];
    assert.ok(entry?.version);
    const resolvedPath = await library.resolve(entry.id, entry.version!);
    assert.equal(path.basename(resolvedPath!), path.basename(filePath));
    const request = {
      id: entry.id, version: entry.version!, size: entry.size, filePath: resolvedPath!, epoch: library.frameIndexes.epoch,
      identity: { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 3, indexerBuild },
    };
    const firstSubscriber = library.indexJobs.startBuild(request, { onUpdate() {} });
    firstSubscriber.unsubscribe();
    const resumedSubscriber = library.indexJobs.startBuild(request, { onUpdate() {} });
    assert.equal(resumedSubscriber.buildId, firstSubscriber.buildId);
    const result = await resumedSubscriber.promise as { built: boolean; profile?: Record<string, any> };
    assert.equal(result.built, true);
    const profile = result.profile!;
    assert.equal(profile.scanMode, 'demux-only');
    assert.equal(profile.scanDecodedPackets, 0);
    assert.ok(profile.totalBuildWallMs > 0);
    assert.ok(profile.cpuUserMs + profile.cpuSystemMs > 0);
    assert.ok(profile.vpOpenBlobMs > 0);
    assert.ok(profile.vpPrimeFirstPresentableMs >= 0);
    assert.ok(profile.scanStepCalls > 0);
    assert.ok(profile.packets > 0);
    assert.ok(profile.scannedBytes > 0);
    assert.ok(profile.scanCompleteMs > 0);
    assert.ok(profile.avioReadCalls > 0);
    assert.equal(profile.avioAverageReadBytes, profile.avioActualBytes / profile.avioReadCalls);
    assert.ok(profile.avioReadSyncMs >= 0);
    assert.ok(profile.avioArrayBufferCopyMs >= 0);
    assert.ok(profile.recordExportBytes > 0);
    assert.ok(profile.firstPresentationReadyMs >= 0);
    assert.ok(profile.firstStableBatchReadyMs >= 0);
    assert.ok(profile.firstStableBatchReadyMs >= profile.scanCompleteMs,
      'demux-only index batches must wait for scan finality');
    assert.ok(profile.storage.progressUpdateCount > 0);
    assert.ok(profile.storage.batchAppendCount > 0);
    assert.ok(profile.storage.finishMs >= 0);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildFfmpegIndexDocument } from '../../server/frame-index-builder.ts';
import { FfmpegPacketIndex } from '../../src/analysis/ffmpeg-adapter.ts';

test('shared WebM/TS/MKV records match ffprobe packet identity and compressed bytes without scan decoding', async t => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  const glue = await import(pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href);
  const { core } = await instantiateCore(glue.default, new Uint8Array(await readFile(path.join(coreDir, 'voidplayer-core.wasm'))));
  const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []);
  for (const name of ['av1_10s_1920x1080.webm', 'mpeg2_10s_1280x720.ts', 'ffv1_yuv422p_8bit.mkv']) {
    await t.test(name, async () => {
      const file = path.resolve('fixtures/video', name), stat = statSync(file);
      const version = createHash('sha256').update(stat.size + ':' + Math.round(stat.mtimeMs) + ':' + Math.round(stat.ctimeMs) + ':' + stat.ino).digest('hex').slice(0, 24);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts,dts,size', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
      const records: Uint8Array[] = [];
      const built = await buildFfmpegIndexDocument(file, stat.size, version, coreDir, { kind: 'ffmpeg', streamKey: 'video:0', schemaVersion: 3, indexerBuild }, undefined, undefined, batch => records.push(batch.records));
      assert.equal(built.profile.scanDecodedPackets, 0);
      assert.equal(built.count, probe.packets.length);
      const packets = new FfmpegPacketIndex();
      for (const batch of records) {
        const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
        for (let offset = 0; offset < batch.length; offset += 48) {
          const original = probe.packets[Number(view.getBigUint64(offset + 40, true))];
          assert.equal(view.getInt32(offset + 32, true), Number(original.size));
          assert.equal(view.getBigInt64(offset, true), original.pts === undefined ? -9223372036854775808n : BigInt(original.pts));
          assert.equal(view.getBigInt64(offset + 8, true), original.dts === undefined ? -9223372036854775808n : BigInt(original.dts));
        }
        packets.append(batch, built.metadata.timeBaseNum, built.metadata.timeBaseDen);
      }
      assert.equal(packets.summary.packetCount, built.count);
      for (let ordinal = 0; ordinal < built.count; ordinal++) assert.equal(packets.locate('source', 0, `source:v:${ordinal}`)?.sizeBytes, Number(probe.packets[ordinal].size));
    });
  }
});

test('core imports untimed tail batches atomically with original ordinal uniqueness', async () => {
  const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
  const glue = await import(pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href);
  const { core, heap } = await instantiateCore(glue.default, new Uint8Array(await readFile(path.join(coreDir, 'voidplayer-core.wasm'))));
  const bytes = new Uint8Array(await readFile('fixtures/video/ffv1_yuv422p_8bit.mkv'));
  const ctx = core.ccall('vp_create', 'number', [], []);
  core.vpBlobs = new Map([[ctx, { blob: { size: bytes.length, slice(start: number, end: number) { return bytes.slice(start, end); } }, reader: { readAsArrayBuffer(value: Uint8Array) { return value.buffer; } } }]]);
  const ptr = core._malloc(144);
  try {
    assert.equal(core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, ctx, BigInt(bytes.length)]), 0);
    assert.equal(core.ccall('vp_index_import_begin', 'number', ['number'], [ctx]), 1);
    heap().fill(0, ptr, ptr + 144);
    const view = new DataView(heap().buffer);
    [0n, 100n, -9223372036854775808n].forEach((pts, i) => {
      view.setBigInt64(ptr + i * 48, pts, true); view.setBigInt64(ptr + i * 48 + 8, pts, true);
      view.setBigInt64(ptr + i * 48 + 24, -1n, true); view.setInt32(ptr + i * 48 + 32, 20 + i, true);
      view.setBigUint64(ptr + i * 48 + 40, BigInt([1, 0, 2][i]), true);
    });
    const call = (offset: number, count: number, seq: number, final: number) => core.ccall('vp_index_import_batch', 'number', ['number', 'number', 'number', 'number', 'i64', 'number'], [ctx, ptr + offset, count, seq, 100n, final]);
    assert.equal(call(0, 2, 0, 0), 2);
    view.setBigUint64(ptr + 136, 1n, true);
    assert.equal(call(96, 1, 1, 1), -1, 'duplicate original ordinal cannot mutate the imported prefix');
    assert.equal(core.ccall('vp_index_count', 'number', ['number'], [ctx]), 2);
    view.setBigUint64(ptr + 136, 2n, true);
    assert.equal(call(96, 1, 1, 1), 1, 'unknown-only tail keeps the last finite watermark');
    assert.equal(core.ccall('vp_index_count', 'number', ['number'], [ctx]), 3);
    assert.equal(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, 2]), -9223372036854775808n);
    assert.equal(core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, ptr, 144]), 3);
    assert.equal(view.getBigUint64(ptr + 40, true), 1n);
    assert.equal(view.getBigUint64(ptr + 136, true), 2n);
  } finally { core._free(ptr); core.ccall('vp_destroy', null, ['number'], [ctx]); }
});
