import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../src/wasm-core.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_SCHEMA, FFMPEG_NO_TIMESTAMP } from '../src/ffmpeg-index-cache.ts';
import type { FfmpegIndexMetadata } from '../src/ffmpeg-index-cache.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

export function hasServerIndexCore(coreDir: string): boolean {
  return existsSync(path.join(coreDir, 'voidplayer-core.js')) && existsSync(path.join(coreDir, 'voidplayer-core.wasm'));
}

function fileVersion(stat: Stats) {
  return createHash('sha256').update(stat.size + ':' + Math.round(stat.mtimeMs) + ':' + Math.round(stat.ctimeMs) + ':' + stat.ino).digest('hex').slice(0, 24);
}

export interface FfmpegIndexBuildProgress {
  phase: 'scan';
  packets: number;
  scannedBytes: number;
  totalBytes: number;
}

export interface FfmpegIndexStreamMetadata extends FfmpegIndexMetadata {
  schema: number;
  kind: 'ffmpeg-container';
  recordBytes: number;
  firstPts: string;
  originVerified: boolean;
}

export interface FfmpegIndexBuildBatch {
  seq: number;
  count: number;
  records: Uint8Array;
  safePresentationUs: number;
  scannedBytes: number;
}

export interface FfmpegIndexBuildProfile {
  scanMode: 'demux-only';
  scanDecodedPackets: number;
  totalBuildWallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  vpOpenBlobMs: number;
  vpPrimeFirstPresentableMs: number;
  vpIndexScanStepMs: number;
  scanStepCalls: number;
  scannedBytes: number;
  packets: number;
  scanCompleteMs?: number;
  avioReadCalls: number;
  avioRequestedBytes: number;
  avioActualBytes: number;
  avioAverageReadBytes: number;
  avioReadSyncMs: number;
  avioAllocationMs: number;
  avioArrayBufferCopyMs: number;
  recordExportMs: number;
  recordExportBytes: number;
  firstPresentationReadyMs?: number;
  firstStableBatchReadyMs?: number;
  storage?: {
    progressUpdateCount: number;
    progressUpdateMs: number;
    batchAppendCount: number;
    batchAppendMs: number;
    firstBatchAppendMs?: number;
    finishMs: number;
  };
}

const RECORDS_PER_BATCH = 128; // Keep persistence writes and subscriber events bounded.

/** Build a server index from local-file AVIO and persist validated record batches. */
export async function buildFfmpegIndexDocument(
  filePath: string,
  expectedSize: number,
  expectedVersion: string,
  coreDir: string,
  identity: MediaIndexIdentity,
  onProgress?: (progress: FfmpegIndexBuildProgress) => void,
  onManifest?: (metadata: FfmpegIndexStreamMetadata) => void,
  onBatch?: (batch: FfmpegIndexBuildBatch) => void,
): Promise<{ metadata: FfmpegIndexStreamMetadata; count: number; stablePresentationUs: number; scannedBytes: number; profile: FfmpegIndexBuildProfile }> {
  const buildStarted = performance.now();
  const cpuStarted = process.cpuUsage();
  const profile: FfmpegIndexBuildProfile = {
    scanMode: 'demux-only', scanDecodedPackets: 0,
    totalBuildWallMs: 0, cpuUserMs: 0, cpuSystemMs: 0,
    vpOpenBlobMs: 0, vpPrimeFirstPresentableMs: 0, vpIndexScanStepMs: 0,
    scanStepCalls: 0, scannedBytes: 0, packets: 0,
    avioReadCalls: 0, avioRequestedBytes: 0, avioActualBytes: 0, avioAverageReadBytes: 0,
    avioReadSyncMs: 0, avioAllocationMs: 0, avioArrayBufferCopyMs: 0,
    recordExportMs: 0, recordExportBytes: 0,
  };
  if (!hasServerIndexCore(coreDir)) throw new Error('服务端 FFmpeg WASM core 不可用。');
  const stat = statSync(filePath);
  const assertSameFile = (stage: string) => {
    const current = statSync(filePath);
    if (!current || !current.isFile() || current.size !== expectedSize || fileVersion(current) !== expectedVersion) {
      throw new Error(`媒体文件在${stage}已改变。`);
    }
  };
  assertSameFile('建立索引前');
  const gluePath = path.join(coreDir, 'voidplayer-core.js');
  const wasmPath = path.join(coreDir, 'voidplayer-core.wasm');
  const wasm = new Uint8Array(await readFile(wasmPath));
  const glue = await import(pathToFileURL(gluePath).href);
  const { core, heap } = await instantiateCore(glue.default, wasm);
  const fd = openSync(filePath, 'r');
  let ctx = 0;
  try {
    core.vpBlobs = new Map();
    if (core.ccall('vp_index_abi_version', 'number', [], []) !== FFMPEG_INDEX_SCHEMA
      || core.ccall('vp_index_record_bytes', 'number', [], []) !== FFMPEG_INDEX_RECORD_BYTES
      || core.ccall('vp_index_stream_abi_version', 'number', [], []) !== 2) {
      throw new Error('服务端 FFmpeg core 索引 ABI 不匹配。');
    }
    ctx = core.ccall('vp_create', 'number', [], []);
    if (!ctx) throw new Error('服务端无法创建 FFmpeg 索引上下文。');
    const fileSize = stat.size;
    const blob = { size: fileSize, slice(start: number, end: number) { return { start, end }; } };
    const reader = {
      readAsArrayBuffer(range: { start: number; end: number }) {
        const start = Math.max(0, Math.min(fileSize, Math.trunc(range.start)));
        const end = Math.max(start, Math.min(fileSize, Math.trunc(range.end)));
        const allocationStarted = performance.now();
        const buffer = Buffer.allocUnsafe(end - start);
        profile.avioAllocationMs += performance.now() - allocationStarted;
        let total = 0;
        const readStarted = performance.now();
        while (total < buffer.length) {
          const got = readSync(fd, buffer, total, buffer.length - total, start + total);
          if (!got) break;
          total += got;
        }
        profile.avioReadSyncMs += performance.now() - readStarted;
        profile.avioReadCalls++;
        profile.avioRequestedBytes += end - start;
        profile.avioActualBytes += total;
        const copyStarted = performance.now();
        const result = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + total);
        profile.avioArrayBufferCopyMs += performance.now() - copyStarted;
        return result;
      },
    };
    core.vpBlobs.set(ctx, { blob, reader });
    const openStarted = performance.now();
    const openResult = core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, ctx, BigInt(fileSize)]);
    profile.vpOpenBlobMs = performance.now() - openStarted;
    if (openResult !== 0) {
      throw new Error('服务端 FFmpeg 无法打开媒体容器。');
    }
    const streamIndex = core.ccall('vp_stream_index', 'number', ['number'], [ctx]) as number;
    const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []) as string;
    if (identity.kind !== 'ffmpeg' || identity.schemaVersion !== FFMPEG_INDEX_SCHEMA
      || identity.streamKey !== `video:${streamIndex}` || identity.indexerBuild !== indexerBuild) {
      throw new Error('媒体索引身份与服务端 FFmpeg core 不匹配。');
    }
    const primeStarted = performance.now();
    const primeResult = core.ccall('vp_prime_first_presentable', 'number', ['number'], [ctx]);
    profile.vpPrimeFirstPresentableMs = performance.now() - primeStarted;
    if (primeResult !== 1) {
      throw new Error('服务端 FFmpeg 无法确定首个可显示画面的时间轴起点。');
    }
    const firstPts = BigInt(core.ccall('vp_last_ticks', 'i64', ['number'], [ctx]) as number);
    if (firstPts === -1n) throw new Error('服务端 FFmpeg 首帧时间戳无效。');
    const metadata: FfmpegIndexStreamMetadata = {
      schema: FFMPEG_INDEX_SCHEMA, kind: 'ffmpeg-container', size: fileSize,
      codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
      timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
      timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
      width: core.ccall('vp_width', 'number', ['number'], [ctx]),
      height: core.ccall('vp_height', 'number', ['number'], [ctx]),
      streamIndex, indexerBuild, recordBytes: FFMPEG_INDEX_RECORD_BYTES, firstPts: firstPts.toString(),
      originVerified: true,
    };
    profile.firstPresentationReadyMs = performance.now() - buildStarted;
    onManifest?.(metadata);

    // Building packet timing/seek metadata does not require decoding every
    // packet. Keep the first-presentable-frame probe above separate, then use
    // the core's demux-only scan and publish the complete index after EOF.
    if (core.ccall('vp_index_scan_begin', 'number', ['number'], [ctx]) !== 1) {
      throw new Error('服务端 FFmpeg 无法开始媒体帧索引。');
    }
    let seq = 0;
    let batchCount = 0;
    let publishedRecords = 0;
    let batch = new Uint8Array(RECORDS_PER_BATCH * FFMPEG_INDEX_RECORD_BYTES);
    let lastPublishedTick = firstPts;
    let stablePresentationUs = 0;
    const publish = (count: number, scannedBytes: number) => {
      if (!count) return;
      const records = batch.slice(0, count * FFMPEG_INDEX_RECORD_BYTES);
      const delta = lastPublishedTick - firstPts;
      stablePresentationUs = Math.max(0, Math.floor(Number(delta) * 1_000_000 * metadata.timeBaseNum / metadata.timeBaseDen));
      assertSameFile('索引流传输前');
      if (profile.firstStableBatchReadyMs === undefined) profile.firstStableBatchReadyMs = performance.now() - buildStarted;
      onBatch?.({ seq: seq++, count, records, safePresentationUs: stablePresentationUs, scannedBytes });
      publishedRecords += count;
      batchCount = 0;
      batch = new Uint8Array(RECORDS_PER_BATCH * FFMPEG_INDEX_RECORD_BYTES);
    };
    const ingest = (bytes: Uint8Array, count: number, scannedBytes: number) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count; i++) {
        const sourceOffset = i * FFMPEG_INDEX_RECORD_BYTES;
        const pts = view.getBigInt64(sourceOffset, true);
        // Keep preroll records and their seek anchors in the payload. The
        // browser hides timestamps before its immutable first-frame origin.
        batch.set(bytes.subarray(sourceOffset, sourceOffset + FFMPEG_INDEX_RECORD_BYTES), batchCount * FFMPEG_INDEX_RECORD_BYTES);
        batchCount++;
        if (pts !== FFMPEG_NO_TIMESTAMP) lastPublishedTick = pts;
        if (batchCount === RECORDS_PER_BATCH) publish(batchCount, scannedBytes);
      }
    };
    while (!core.ccall('vp_index_scan_complete', 'number', ['number'], [ctx])) {
      const stepStarted = performance.now();
      const step = core.ccall('vp_index_scan_step', 'number', ['number', 'number'], [ctx, 1024]) as number;
      profile.vpIndexScanStepMs += performance.now() - stepStarted;
      profile.scanStepCalls++;
      if (step < 0 || core.ccall('vp_index_scan_failed', 'number', ['number'], [ctx])) throw new Error('服务端 FFmpeg 媒体帧索引扫描失败。');
      const scannedBytes = Math.min(fileSize, Math.max(0, Number(core.ccall('vp_index_scan_bytes', 'i64', ['number'], [ctx]))));
      const packets = core.ccall('vp_index_scan_packets', 'number', ['number'], [ctx]) as number;
      profile.packets = packets;
      profile.scannedBytes = scannedBytes;
      onProgress?.({ phase: 'scan', packets, scannedBytes, totalBytes: fileSize });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    profile.scanDecodedPackets = Number(core.ccall('vp_index_scan_decoded_packets', 'number', ['number'], [ctx]));
    if (profile.scanDecodedPackets !== 0) throw new Error('包索引扫描意外进入解码路径。');
    profile.scanCompleteMs = performance.now() - buildStarted;
    const count = core.ccall('vp_index_count', 'number', ['number'], [ctx]) as number;
    if (count <= 0) throw new Error('服务端 FFmpeg 无法建立媒体帧索引。');
    if (typeof core._vp_index_recovery_abi_version !== 'function' || core.ccall('vp_index_recovery_abi_version', 'number', [], []) !== 1)
      throw new Error('服务端 FFmpeg 损坏恢复接口版本不匹配。');
    metadata.indexIntegrity = core.ccall('vp_index_integrity', 'number', ['number'], [ctx]) ? 'prefix' : 'complete';
    if (metadata.indexIntegrity === 'prefix') {
      metadata.indexTruncatedAt = Number(core.ccall('vp_index_truncated_at', 'i64', ['number'], [ctx]));
      metadata.indexEndDts = String(core.ccall('vp_index_end_dts', 'i64', ['number'], [ctx]));
    }
    if (count > 2_000_000) throw new Error('媒体帧数超过服务端索引上限。');
    const scannedBytes = Math.min(fileSize, Math.max(0, Number(core.ccall('vp_index_scan_bytes', 'i64', ['number'], [ctx]))));
    profile.scannedBytes = scannedBytes;
    profile.packets = Number(core.ccall('vp_index_scan_packets', 'number', ['number'], [ctx]));
    const totalBytes = count * FFMPEG_INDEX_RECORD_BYTES;
    const ptr = core._malloc(totalBytes);
    if (!ptr) throw new Error('服务端 FFmpeg 索引内存分配失败。');
    try {
      const exportStarted = performance.now();
      const exported = core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, ptr, totalBytes]) as number;
      if (exported !== count) throw new Error('服务端 FFmpeg 完整索引导出失败。');
      const bytes = heap().slice(ptr, ptr + totalBytes);
      profile.recordExportMs += performance.now() - exportStarted;
      profile.recordExportBytes += totalBytes;
      ingest(bytes, count, scannedBytes);
    } finally { core._free(ptr); }
    publish(batchCount, scannedBytes);
    if (!seq) throw new Error('服务端 FFmpeg 没有可公开的呈现帧。');
    assertSameFile('建立索引时');
    profile.avioAverageReadBytes = profile.avioReadCalls ? profile.avioActualBytes / profile.avioReadCalls : 0;
    return { metadata, count: publishedRecords, stablePresentationUs, scannedBytes, profile };
  } finally {
    if (ctx) {
      core.vpBlobs.delete(ctx);
      core.ccall('vp_destroy', null, ['number'], [ctx]);
    }
    closeSync(fd);
    profile.totalBuildWallMs = performance.now() - buildStarted;
    const cpu = process.cpuUsage(cpuStarted);
    profile.cpuUserMs = cpu.user / 1000;
    profile.cpuSystemMs = cpu.system / 1000;
  }
}
