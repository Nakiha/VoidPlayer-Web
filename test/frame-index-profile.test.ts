import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MediaLibraryIndex } from '../server/library.ts';
import { instantiateCore } from '../src/wasm-core.ts';

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
      identity: { kind: 'ffmpeg' as const, streamKey: 'video:0', schemaVersion: 2, indexerBuild },
    };
    const firstSubscriber = library.indexJobs.startBuild(request, { onUpdate() {} });
    firstSubscriber.unsubscribe();
    const resumedSubscriber = library.indexJobs.startBuild(request, { onUpdate() {} });
    assert.equal(resumedSubscriber.buildId, firstSubscriber.buildId);
    const result = await resumedSubscriber.promise as { built: boolean; profile?: Record<string, any> };
    assert.equal(result.built, true);
    const profile = result.profile!;
    assert.ok(profile.totalBuildWallMs > 0);
    assert.ok(profile.cpuUserMs + profile.cpuSystemMs > 0);
    assert.ok(profile.vpOpenBlobMs > 0);
    assert.ok(profile.vpPrimeFirstPresentableMs >= 0);
    assert.ok(profile.scanStepCalls > 0);
    assert.ok(profile.packets > 0);
    assert.ok(profile.scannedBytes > 0);
    assert.ok(profile.avioReadCalls > 0);
    assert.equal(profile.avioAverageReadBytes, profile.avioActualBytes / profile.avioReadCalls);
    assert.ok(profile.avioReadSyncMs >= 0);
    assert.ok(profile.avioArrayBufferCopyMs >= 0);
    assert.ok(profile.recordExportBytes > 0);
    assert.ok(profile.firstPresentationReadyMs >= 0);
    assert.ok(profile.firstStableBatchReadyMs >= 0);
    assert.ok(profile.storage.progressUpdateCount > 0);
    assert.ok(profile.storage.batchAppendCount > 0);
    assert.ok(profile.storage.finishMs >= 0);
  } finally {
    await library.close();
    await rm(root, { recursive: true, force: true });
  }
});
