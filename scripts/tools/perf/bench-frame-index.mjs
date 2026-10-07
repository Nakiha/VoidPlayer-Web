// Measure a cold server index build and warm identity lookup for one local media file.
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../../../src/wasm-core.ts';
import { MediaLibraryIndex } from '../../../server/library.ts';

const inputPath = process.argv[2];
if (!inputPath || inputPath === '--help') {
  console.log('Usage: node scripts/bench-frame-index.mjs <media-file> [video-stream-index]');
  process.exit(inputPath ? 0 : 2);
}
const filePath = path.resolve(inputPath);
const streamIndex = Number(process.argv[3] ?? process.env.INDEX_STREAM_INDEX ?? 0);
if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex > 64) throw new Error('Invalid video stream index.');
const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
if (!existsSync(path.join(coreDir, 'voidplayer-core.js')) || !existsSync(path.join(coreDir, 'voidplayer-core.wasm'))) {
  throw new Error(`WASM core not found at ${coreDir}; run scripts/sync-wasm-core.sh first.`);
}
const wasm = new Uint8Array(await readFile(path.join(coreDir, 'voidplayer-core.wasm')));
const glue = await import(pathToFileURL(path.join(coreDir, 'voidplayer-core.js')).href);
const { core } = await instantiateCore(glue.default, wasm);
const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []);
const fileStat = await stat(filePath);
const library = new MediaLibraryIndex([path.dirname(filePath)], { watch: false });
try {
  await library.refresh();
  const entry = library.browse().entries.find(item => item.name === path.basename(filePath) && item.size === fileStat.size);
  if (!entry?.version) throw new Error('The media file is not available in the library index.');
  const resolved = await library.resolve(entry.id, entry.version);
  if (!resolved) throw new Error('The media file changed during benchmark setup.');
  const identity = { kind: 'ffmpeg', streamKey: `video:${streamIndex}`, schemaVersion: 3, indexerBuild };
  const coldStartedAt = performance.now();
  const build = library.indexJobs.startBuild({
    id: entry.id, version: entry.version, size: entry.size, filePath: resolved,
    epoch: library.frameIndexes.epoch, identity,
  });
  const result = await build.promise;
  const coldWallMs = performance.now() - coldStartedAt;
  const warmStartedAt = performance.now();
  const warm = await library.indexJobs.call('stream-manifest', { id: entry.id, version: entry.version, identity });
  const warmLookupMs = performance.now() - warmStartedAt;
  const profile = result.profile;
  const summary = {
    file: path.basename(filePath), sizeBytes: entry.size, identity, buildId: build.buildId,
    built: result.built, coldWallMs: Math.round(coldWallMs), warmLookupMs: Number(warmLookupMs.toFixed(2)),
    firstPresentationReadyMs: profile?.firstPresentationReadyMs,
    firstStableBatchMs: profile?.storage?.firstBatchAppendMs,
    scanThroughputMiBPerSec: profile?.totalBuildWallMs > 0
      ? Number((profile.scannedBytes / 1024 ** 2 / (profile.totalBuildWallMs / 1000)).toFixed(2)) : 0,
    scan: { scannedBytes: profile?.scannedBytes, packets: profile?.packets, stepCalls: profile?.scanStepCalls,
      totalBuildWallMs: profile?.totalBuildWallMs, scanCompleteMs: profile?.scanCompleteMs,
      cpuUserMs: profile?.cpuUserMs, cpuSystemMs: profile?.cpuSystemMs },
    avio: { readCalls: profile?.avioReadCalls, requestedBytes: profile?.avioRequestedBytes, actualBytes: profile?.avioActualBytes,
      averageReadBytes: profile?.avioAverageReadBytes, readSyncMs: profile?.avioReadSyncMs,
      allocationMs: profile?.avioAllocationMs, arrayBufferCopyMs: profile?.avioArrayBufferCopyMs },
    records: { exportMs: profile?.recordExportMs, bytes: profile?.recordExportBytes },
    sqlite: profile?.storage,
    warmCacheState: warm?.manifest?.state,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await library.close();
}
