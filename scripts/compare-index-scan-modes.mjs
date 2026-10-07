// Compare demux-only indexing with MPEG-TS decoder-backed progressive indexing
// on the exact same local file and bundled WASM core. Correctness is checked
// across H.264, HEVC open-GOP/B-frame, and MPEG-2 fixtures by the test suite.
// Usage: node scripts/compare-index-scan-modes.mjs <media.ts> [--budget=1024]
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../src/wasm-core.ts';

const args = process.argv.slice(2);
const inputArg = args.find(arg => !arg.startsWith('--'));
if (!inputArg || inputArg === '--help') {
  console.log('Usage: node scripts/compare-index-scan-modes.mjs <media.ts> [--budget=1024]');
  process.exit(inputArg ? 0 : 2);
}
const budgetArg = args.find(arg => arg.startsWith('--budget='));
const packetBudget = Number(budgetArg?.slice('--budget='.length) ?? 1024);
if (!Number.isSafeInteger(packetBudget) || packetBudget < 1 || packetBudget > 16384) {
  throw new Error('packet budget must be an integer from 1 to 16384');
}

const inputPath = path.resolve(inputArg);
const fileStat = statSync(inputPath);
const coreDir = process.env.WASM_CORE_DIR || path.resolve('public/vendor/voidplayer-core');
const gluePath = path.join(coreDir, 'voidplayer-core.js');
const wasmPath = path.join(coreDir, 'voidplayer-core.wasm');
if (!existsSync(gluePath) || !existsSync(wasmPath)) {
  throw new Error(`WASM core not found at ${coreDir}; run scripts/sync-wasm-core.sh first.`);
}

const glue = await import(pathToFileURL(gluePath).href);
const wasm = new Uint8Array(readFileSync(wasmPath));
const { core, heap } = await instantiateCore(glue.default, wasm);
core.vpBlobs = new Map();
const coreBuildId = core.ccall('vp_core_build_id', 'string', [], []);
assert.equal(core.ccall('vp_index_abi_version', 'number', [], []), 3);
assert.equal(core.ccall('vp_index_record_bytes', 'number', [], []), 48);
assert.equal(core.ccall('vp_index_stream_abi_version', 'number', [], []), 2);

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function readPixels(ctx) {
  const descriptor = core.ccall('vp_frame_info', 'number', ['number'], [ctx]);
  if (!descriptor) throw new Error('decoder did not expose a frame descriptor');
  const view = new DataView(heap().buffer, descriptor, 160);
  const size = view.getInt32(36, true);
  const pointer = core.ccall('vp_pixels', 'number', ['number'], [ctx]);
  if (size <= 0 || pointer <= 0 || pointer + size > heap().byteLength) throw new Error('decoder returned an invalid pixel buffer');
  return heap().slice(pointer, pointer + size);
}

async function runMode(mode) {
  const fd = openSync(inputPath, 'r');
  const ctx = core.ccall('vp_create', 'number', [], []);
  if (!ctx) throw new Error('vp_create failed');
  const blob = { size: fileStat.size, slice(start, end) { return { start, end }; } };
  const reader = {
    readAsArrayBuffer(range) {
      const start = Math.max(0, Math.min(fileStat.size, Math.trunc(range.start)));
      const end = Math.max(start, Math.min(fileStat.size, Math.trunc(range.end)));
      const buffer = Buffer.allocUnsafe(end - start);
      let total = 0;
      while (total < buffer.length) {
        const got = readSync(fd, buffer, total, buffer.length - total, start + total);
        if (!got) break;
        total += got;
      }
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + total);
    },
  };

  try {
    core.vpBlobs.set(ctx, { blob, reader });
    const openResult = core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, ctx, BigInt(fileStat.size)]);
    if (openResult !== 0) throw new Error(`vp_open_blob failed (${openResult})`);
    const streamIndex = core.ccall('vp_stream_index', 'number', ['number'], [ctx]);

    const firstStarted = performance.now();
    if (core.ccall('vp_prime_first_presentable', 'number', ['number'], [ctx]) !== 1) {
      throw new Error('vp_prime_first_presentable failed');
    }
    const firstFrameMs = performance.now() - firstStarted;
    const firstFrameHash = digest(readPixels(ctx));

    const begin = mode === 'progressive' ? 'vp_index_scan_stream_begin' : 'vp_index_scan_begin';
    if (core.ccall(begin, 'number', ['number'], [ctx]) !== 1) throw new Error(`${begin} failed`);
    const cpuStart = process.cpuUsage();
    const scanStarted = performance.now();
    let steps = 0;
    let demuxPacketCount = 0;
    let firstStableBatchMs;
    let firstStableTicks;
    let maxStepMs = 0;
    let lastLogAt = scanStarted;

    while (!core.ccall('vp_index_scan_complete', 'number', ['number'], [ctx])) {
      const stepStarted = performance.now();
      const read = core.ccall('vp_index_scan_step', 'number', ['number', 'number'], [ctx, packetBudget]);
      const stepMs = performance.now() - stepStarted;
      if (read < 0 || core.ccall('vp_index_scan_failed', 'number', ['number'], [ctx])) {
        throw new Error(`index scan failed in step ${steps + 1}`);
      }
      maxStepMs = Math.max(maxStepMs, stepMs);
      steps++;
      demuxPacketCount += read;
      const scannedBytes = Number(core.ccall('vp_index_scan_bytes', 'i64', ['number'], [ctx]));
      const stableCount = Number(core.ccall('vp_index_scan_stable_count', 'number', ['number'], [ctx]));
      if (firstStableBatchMs === undefined && stableCount > 0) {
        firstStableBatchMs = performance.now() - scanStarted;
        firstStableTicks = BigInt(core.ccall('vp_index_scan_stable_ticks', 'i64', ['number'], [ctx]));
      }
      if (steps === 1 || steps % 5 === 0 || performance.now() - lastLogAt > 3000) {
        console.log(JSON.stringify({ mode, step: steps, demuxPackets: demuxPacketCount, scannedBytes, stableRecords: stableCount, stepMs: Number(stepMs.toFixed(1)) }));
        lastLogAt = performance.now();
      }
      await new Promise(resolve => setImmediate(resolve));
    }

    const scanWallMs = performance.now() - scanStarted;
    const cpu = process.cpuUsage(cpuStart);
    const recordCount = Number(core.ccall('vp_index_count', 'number', ['number'], [ctx]));
    if (recordCount <= 0) throw new Error('index is empty');
    const recordBytes = Number(core.ccall('vp_index_export_bytes', 'number', ['number'], [ctx]));
    if (recordBytes !== recordCount * 48) throw new Error(`unexpected record byte size: ${recordBytes}`);
    const recordPtr = core._malloc(recordBytes);
    if (!recordPtr) throw new Error('index export allocation failed');
    let records;
    try {
      if (core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, recordPtr, recordBytes]) !== recordCount) {
        throw new Error('vp_index_export failed');
      }
      records = heap().slice(recordPtr, recordPtr + recordBytes);
    } finally { core._free(recordPtr); }

    const firstPts = BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, 0]));
    const lastPts = BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, recordCount - 1]));
    const lastDuration = BigInt(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, recordCount - 1]));
    const durationTicks = lastPts - firstPts + lastDuration;
    const tbNum = Number(core.ccall('vp_tb_num', 'number', ['number'], [ctx]));
    const tbDen = Number(core.ccall('vp_tb_den', 'number', ['number'], [ctx]));
    const mediaDurationSeconds = Number(durationTicks) * tbNum / tbDen;
    const requestedIndices = [...new Set([Math.floor(recordCount * 0.1), Math.floor(recordCount * 0.25),
      Math.floor(recordCount * 0.5), Math.floor(recordCount * 0.75), Math.floor(recordCount * 0.9)])];
    const seekHashes = [];
    for (const requestedIndex of requestedIndices) {
      const candidates = [];
      for (let distance = 0; distance <= 8; distance++) {
        const before = requestedIndex - distance;
        const after = requestedIndex + distance;
        if (before >= 0 && !candidates.includes(before)) candidates.push(before);
        if (after < recordCount && !candidates.includes(after)) candidates.push(after);
      }
      const attempts = [];
      let match;
      for (const index of candidates) {
        const pts = BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, index]));
        const extractResult = core.ccall('vp_extract', 'number', ['number', 'i64'], [ctx, pts]);
        if (extractResult === 1) {
          match = { requestedIndex, index, pts: pts.toString(), hash: digest(readPixels(ctx)) };
          break;
        }
        attempts.push({ index, pts: pts.toString(), result: extractResult });
      }
      seekHashes.push(match ?? { requestedIndex, failedAttempts: attempts });
    }

    const result = {
      mode: mode === 'progressive' ? 'decoder-backed-progressive' : 'demux-only-full-index',
      file: path.basename(inputPath), sizeBytes: fileStat.size, streamIndex, coreBuildId, packetBudget,
      firstFrameMs: Number(firstFrameMs.toFixed(2)), firstFrameHash,
      scanWallMs: Number(scanWallMs.toFixed(2)), cpuUserMs: Number((cpu.user / 1000).toFixed(2)), cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
      MiBPerSec: Number((fileStat.size / 1024 ** 2 / (scanWallMs / 1000)).toFixed(2)),
      mediaDurationSeconds: Number(mediaDurationSeconds.toFixed(3)),
      durationTicks: durationTicks.toString(),
      realtimeFactor: Number((mediaDurationSeconds / (scanWallMs / 1000)).toFixed(3)),
      indexedVideoPacketsPerSecond: Number((recordCount / (scanWallMs / 1000)).toFixed(1)),
      demuxPackets: demuxPacketCount, recordCount, recordHash: digest(records),
      scanDecodedPackets: core.ccall('vp_index_scan_decoded_packets', 'number', ['number'], [ctx]),
      firstPts: firstPts.toString(), lastPts: lastPts.toString(), seekAnchorCount: core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]),
      progressiveSupported: core.ccall('vp_index_scan_progressive_supported', 'number', ['number'], [ctx]) === 1,
      firstStableBatchMs: firstStableBatchMs === undefined ? null : Number(firstStableBatchMs.toFixed(2)),
      firstStableTicks: firstStableTicks?.toString() ?? null,
      steps, maxStepMs: Number(maxStepMs.toFixed(2)), seekHashes,
    };
    return { result, records };
  } finally {
    core.vpBlobs.delete(ctx);
    core.ccall('vp_destroy', null, ['number'], [ctx]);
    closeSync(fd);
  }
}

const progressive = await runMode('progressive');
const demuxOnly = await runMode('demux-only');
const comparison = {
  sameRecordBytes: Buffer.from(progressive.records).equals(Buffer.from(demuxOnly.records)),
  sameCount: progressive.result.recordCount === demuxOnly.result.recordCount,
  sameSeekAnchors: progressive.result.seekAnchorCount === demuxOnly.result.seekAnchorCount,
  sameFirstPts: progressive.result.firstPts === demuxOnly.result.firstPts,
  sameDuration: progressive.result.durationTicks === demuxOnly.result.durationTicks,
  sameFirstFrame: progressive.result.firstFrameHash === demuxOnly.result.firstFrameHash,
  sameRandomSeekPixels: JSON.stringify(progressive.result.seekHashes) === JSON.stringify(demuxOnly.result.seekHashes),
  allRandomSeekProbesSucceeded: [...progressive.result.seekHashes, ...demuxOnly.result.seekHashes]
    .every(probe => 'hash' in probe),
};
console.log(JSON.stringify({ progressive: progressive.result, demuxOnly: demuxOnly.result, comparison }, null, 2));
if (!Object.values(comparison).every(Boolean)) process.exitCode = 1;
