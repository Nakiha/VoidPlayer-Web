import {ffmpegAnalysisConfiguration} from '../../../shared/media/indexing/ffmpeg-analysis-config.ts';
import { FfmpegPacketIndex } from '../../../shared/analysis/metadata/ffmpeg-adapter.ts';
import { workerReply } from '../workers/worker-protocol.ts';
import type { FfmpegCommands, FfmpegInitResult, WorkerMessage, WorkerRequest, IndexInput } from '../workers/worker-protocol.ts';

import { rangeBlobReader } from '../io/range-bridge-reader.ts';
import { ObservedBytes } from '../indexing/observed-bytes.ts';
import type { MediaOpenProgress } from '../progress.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';
import { validFfmpegRecovery } from '../../../shared/media/indexing/index-integrity.ts';
import type { FfmpegIndexRecovery } from '../../../shared/media/indexing/index-integrity.ts';
import { randomUUID } from '../../../shared/utils/uuid.ts';
import { decoderConcurrency, loadCore } from './core-loader.ts';
import { createVvcTuner } from './vvc-tuning.ts';
import { readWasmFrame, requireFrameAbi } from './wasm-frame.ts';
import type { MediaIndexTrace, MediaIndexRecordBatch, MediaIndexRecordManifest } from '../../../shared/media/indexing/media-index-types.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_SCHEMA, parseFfmpegIndex, serializeFfmpegIndex, FFMPEG_NO_TIMESTAMP, lastFfmpegPts } from '../../../shared/media/indexing/ffmpeg-index-cache.ts';
// Web Worker hosting the self-built FFmpeg WASM core. Decoding is synchronous
// CPU work; it must never run on the UI thread. The page talks to this worker
// over a small RPC: init (open + first presentable frame), index-input (already
// validated index data from the container session), and extract (exact-PTS
// frame). Pixel buffers are transferred, never copied.

/* eslint-disable @typescript-eslint/no-explicit-any */

type Request = WorkerRequest<FfmpegCommands> | IndexInput;
type Port = {
  onmessage: null | ((event: { data: Request }) => void);
  postMessage(message: WorkerMessage<FfmpegCommands>, transfer?: Transferable[]): void;
};
const port = globalThis as unknown as Port;
const reply = workerReply<FfmpegCommands>();

let core: any = null;
let heap: () => Uint8Array;
/** Native IO must unwind allocations before the original JS read failure is
 * propagated with its input/resource stage intact. */
function ioCall(name: string, result: string | null, types: string[], args: unknown[]): any {
  core.vpDemuxError=undefined;
  const value=core.ccall(name,result,types,args);
  const error=core.vpDemuxError;core.vpDemuxError=undefined;
  if(error)throw error;
  return value;
}

let indexRequestId: number | undefined;
type FfmpegIndexSink = {
  manifest(manifest: MediaIndexRecordManifest, trace: MediaIndexTrace): void;
  batch(batch: MediaIndexRecordBatch, trace: MediaIndexTrace): void;
  complete(manifest: MediaIndexRecordManifest, frames: number, trace: MediaIndexTrace): FfmpegInitResult | undefined;
  legacy(index: unknown, trace: MediaIndexTrace): FfmpegInitResult | undefined;
};
type DecodeContext = { packets: FfmpegPacketIndex; indexComplete: boolean; ticks: number[]; durations: number[]; blobHandle: number; path: string; indexSink?: FfmpegIndexSink; tuner?: ReturnType<typeof createVvcTuner> };
const contexts = new Map<number, DecodeContext>();
const observations = new Map<number, ObservedBytes>();
const contextAliases = new Map<number, number>();
let coreInput: { glueURL: string; binary?: Uint8Array; size: number } | undefined;

async function init(payload: FfmpegCommands['init']['request'], onProgress: MediaOpenProgress, onReady?: (data: FfmpegInitResult) => void,
): Promise<FfmpegInitResult> {
  onProgress('decoder');
  const binary = payload.wasmBinary ? new Uint8Array(payload.wasmBinary) : undefined;
  coreInput = { glueURL: payload.glueURL, binary, size: payload.mediaSize ?? payload.blob?.size ?? payload.file?.byteLength ?? 0 };
  const budget = payload.threads;
  const pool = typeof budget === 'object' ? Math.max(budget.general, budget.vvc, budget.vvcTuning?.threads ?? 0) : budget;
  ({ core, heap } = await loadCore(payload.glueURL, binary, undefined, pool));
  requireFrameAbi(core);
  core.vpBlobs = new Map();
  const ctx = core.ccall('vp_create', 'number', [], []);
  if (!ctx) throw new Error('无法创建 WASM 解码上下文。');
  const path = `/vp-in-${randomUUID()}`;
  const observed = new ObservedBytes(); observations.set(ctx, observed);
  let blobHandle = 0;
  let firstPresentation: ReturnType<typeof readWasmFrame> | undefined;
  try {
    // Player-assigned decode thread budget (no-op on the single-thread core).
    const threads = typeof budget === 'object' ? budget.general : budget;
    if (threads) core.ccall('vp_set_threads', null, ['number'], [threads]);
    if (typeof budget === 'object') {
      core._vp_set_vvc_threads?.(budget.vvc);
      core._vp_set_vvc_frame_contexts?.(budget.vvcFrameContexts);
    }
    const tuner = createVvcTuner(core, heap, ctx, typeof budget === 'object' ? budget.vvcTuning : undefined);
    // Blobs read on demand through the custom AVIO (FileReaderSync chunks), so
    // no whole-file copy ever enters WASM memory. Node workers lack
    // FileReaderSync and buffer the bytes once (capped) into MEMFS.
    onProgress('inspect');
    let ioMode: FfmpegInitResult['ioMode'] = 'memfs';
    if (payload.range) {
      ioMode = 'http-range'; blobHandle = ctx;
      const { shared, size } = payload.range;
      core.vpBlobs.set(blobHandle, rangeBlobReader(shared, size, message => port.postMessage(message), tuner?.recordInputWait));
      if (ioCall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, blobHandle, BigInt(size)]) !== 0) {
        throw new MediaOpenError('container', '软件解码器未能打开视频轨道：封装、编码可能不受支持，或文件数据不完整。');
      }
    } else if (payload.blob && typeof FileReaderSync !== 'undefined') {
      ioMode = 'blob';
      blobHandle = ctx; // the ctx pointer is already a unique id per context
      const blob = payload.blob, reader = new FileReaderSync();
      core.vpBlobs.set(blobHandle, {
        blob: { slice: (start: number, end: number) => ({ start, end }) },
        reader: { readAsArrayBuffer({ start, end }: { start: number; end: number }) {
          const started = tuner ? performance.now() : 0;
          const buffer = reader.readAsArrayBuffer(blob.slice(start, end));
          tuner?.recordInputWait(performance.now() - started);
          observed.add(start, new Uint8Array(buffer)); return buffer;
        } },
      });
      if (ioCall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, blobHandle, BigInt(payload.blob.size)]) !== 0) {
        throw new MediaOpenError('container', '软件解码器未能打开视频轨道：封装、编码可能不受支持，或文件数据不完整。');
      }
    } else {
      const bytes = payload.file ?? await payload.blob?.arrayBuffer();
      if (!bytes) throw new Error('缺少媒体数据。');
      if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('文件超过 WASM 回退解码的内存上限。');
      observed.add(0, new Uint8Array(bytes));
      core.FS.writeFile(path, new Uint8Array(bytes));
      if (ioCall('vp_open', 'number', ['number', 'string'], [ctx, path]) !== 0) {
        throw new MediaOpenError('container', '软件解码器未能打开视频轨道：封装、编码可能不受支持，或文件数据不完整。');
      }
    }
    onProgress('index');
    const indexStart = performance.now();
    const hasIndexIdentityAbi = typeof core._vp_stream_index === 'function' && typeof core._vp_core_build_id === 'function';
    const streamIndex = hasIndexIdentityAbi ? core.ccall('vp_stream_index', 'number', ['number'], [ctx]) as number : -1;
    const indexerBuild = hasIndexIdentityAbi ? core.ccall('vp_core_build_id', 'string', [], []) as string : '';
    const indexIdentity = { kind: 'ffmpeg' as const, streamKey: `video:${streamIndex}`, schemaVersion: FFMPEG_INDEX_SCHEMA, indexerBuild };
    const canImportIndex = hasIndexIdentityAbi
      && typeof core._vp_index_import === 'function'
      && typeof core._vp_index_export === 'function'
      && typeof core._vp_index_export_bytes === 'function'
      && typeof core._vp_index_seek_anchors === 'function'
      && typeof core._vp_index_abi_version === 'function'
      && typeof core._vp_index_record_bytes === 'function'
      && /^[a-f0-9]{40}$/.test(indexerBuild)
      && core.ccall('vp_index_abi_version', 'number', [], []) === FFMPEG_INDEX_SCHEMA
      && typeof core._vp_index_stream_abi_version === 'function'
      && core.ccall('vp_index_stream_abi_version', 'number', [], []) === 2
      && typeof core._vp_index_import_begin === 'function'
      && typeof core._vp_index_import_batch === 'function'
      && core.ccall('vp_index_record_bytes', 'number', [], []) === FFMPEG_INDEX_RECORD_BYTES;
    let streamImportStarted = false;
    let streamedBuildId = '';
    let streamedCount = 0;
    let streamedLastSeq = -1;
    let streamedSafeTick = FFMPEG_NO_TIMESTAMP;
    let originRecordSkipped = false;
    let recordImportMs = 0;
    let externalIndexTrace: MediaIndexTrace = { serverIndexRequests: 0, reconnects: 0 };
    const importRecordManifest = (manifest: MediaIndexRecordManifest, trace: MediaIndexTrace) => {
      externalIndexTrace = trace;
      const metadata = manifest.metadata;
      if (metadata.size !== payload.mediaSize || metadata.codec !== core.ccall('vp_codec_name', 'string', ['number'], [ctx])
        || metadata.timeBaseNum !== core.ccall('vp_tb_num', 'number', ['number'], [ctx])
        || metadata.timeBaseDen !== core.ccall('vp_tb_den', 'number', ['number'], [ctx])
        || metadata.width !== core.ccall('vp_width', 'number', ['number'], [ctx])
        || metadata.height !== core.ccall('vp_height', 'number', ['number'], [ctx])
        || metadata.streamIndex !== streamIndex || metadata.indexerBuild !== indexerBuild) {
        throw new MediaOpenError('resource', '服务端索引元数据与当前解码流不匹配。');
      }
      const originVerified = metadata.originVerified === true;
      if (originVerified && firstPresentation && String(metadata.firstPts) !== String(firstPresentation.pts)) {
        throw new MediaOpenError('resource', '服务端索引改变了首帧时间轴起点。');
      }
      streamedBuildId = manifest.buildId;
    };
    const importRecordBatch = (batch: MediaIndexRecordBatch, trace: MediaIndexTrace) => {
      externalIndexTrace = trace;
      if (!firstPresentation || !streamedBuildId || batch.buildId !== streamedBuildId) throw new MediaOpenError('resource', 'FFmpeg 索引 batch 不属于当前 build。');
      if (!streamImportStarted) {
        if (core.ccall('vp_index_import_begin', 'number', ['number'], [ctx]) !== 1) throw new MediaOpenError('resource', 'FFmpeg 无法开始渐进导入服务端索引。');
        streamImportStarted = true;
      }
      const safeTick = lastFfmpegPts(batch.records, streamedSafeTick);
      const ptr = core._malloc(batch.records.byteLength) >>> 0;
      if (!ptr) throw new MediaOpenError('resource', 'FFmpeg 索引 batch 内存分配失败。');
      const previousCount = streamedCount;
      const importStarted = performance.now();
      try {
        heap().set(batch.records, ptr);
        const imported = core.ccall('vp_index_import_batch', 'number', ['number', 'number', 'number', 'number', 'i64', 'number'],
          [ctx, ptr, batch.count, batch.seq, safeTick, 0]) as number;
        if (imported !== batch.count) throw new MediaOpenError('resource', '服务端 FFmpeg 索引 batch 无法安全导入。');
      } finally { core._free(ptr); recordImportMs += performance.now() - importStarted; }
      streamedCount += batch.count;
      streamedLastSeq = batch.seq;
      streamedSafeTick = safeTick;
      const entry = contexts.get(ctx);
      if (!entry) throw new MediaOpenError('resource', '索引尚未绑定到可播放媒体。');
      const timeBaseNum = core.ccall('vp_tb_num', 'number', ['number'], [ctx]) as number;
      const timeBaseDen = core.ccall('vp_tb_den', 'number', ['number'], [ctx]) as number;
      entry.packets.append(batch.records, timeBaseNum, timeBaseDen);
      const newTicks: number[] = [], newDurations: number[] = [];
      for (let i = previousCount; i < streamedCount; i++) {
        const rawTick = BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i]));
        if (rawTick === FFMPEG_NO_TIMESTAMP) continue;
        const tick = Number(rawTick);
        const duration = Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i]));
        if (tick < firstPresentation.pts) continue;
        if (!originRecordSkipped && tick === firstPresentation.pts) { originRecordSkipped = true; continue; }
        newTicks.push(tick);
        newDurations.push(duration);
      }
      entry.ticks.push(...newTicks);
      entry.durations.push(...newDurations);
      const toUs = (value: number) => Math.round(value * 1e6 * timeBaseNum / timeBaseDen);
      const lastDuration = entry.durations.at(-1) ?? 1;
      const durationCoverageUs = lastDuration > 0 ? Math.max(1, toUs(lastDuration)) : 1;
      const stableCoverageUs = Math.max(1, toUs(Number(safeTick) - firstPresentation.pts) + durationCoverageUs);
      port.postMessage({ id: indexRequestId!, type: 'index-batch', data: { ctx, analysis: entry.packets.summary, ticks: newTicks, durations: newDurations,
        stableCoverageUs, seekAnchorCount: core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]), buildId: streamedBuildId,
        indexIdentity, indexTrace: { ...externalIndexTrace, recordImportMs } } });
    };
    const finishRecordImport = (manifest: MediaIndexRecordManifest, _frames: number, trace: MediaIndexTrace) => {
      externalIndexTrace = trace;
      if (!streamImportStarted) return;
      const result = core.ccall('vp_index_import_batch', 'number', ['number', 'number', 'number', 'number', 'i64', 'number'],
        [ctx, 0, 0, streamedLastSeq + 1, streamedSafeTick, 1]) as number;
      if (result !== 0) throw new MediaOpenError('resource', 'FFmpeg 无法完成服务端索引导入。');
      applyRecovery(manifest.metadata);
    };
    const applyRecovery = (metadata: FfmpegIndexRecovery) => {
      if (!validFfmpegRecovery(metadata, payload.mediaSize ?? payload.blob?.size ?? payload.file?.byteLength ?? payload.range?.size ?? 0))
        throw new MediaOpenError('resource', 'FFmpeg 索引损坏边界无效。');
      if (metadata.indexIntegrity !== 'prefix') return;
      if (typeof core._vp_index_recovery_abi_version !== 'function' || core.ccall('vp_index_recovery_abi_version', 'number', [], []) !== 1
        || core.ccall('vp_index_apply_prefix', 'number', ['number', 'i64', 'i64'], [ctx, BigInt(metadata.indexTruncatedAt!), BigInt(metadata.indexEndDts!)]) !== 1)
        throw new MediaOpenError('resource', 'FFmpeg 无法安全导入损坏前段索引。');
    };
    const makeIndexResult = (count: number, indexSource: 'server' | 'client', localIndexBuildCalls: number): FfmpegInitResult => {
      if (count <= 0) throw new Error('FFmpeg WASM 无法建立该文件的帧索引。');
      const ticks: number[] = [], durations: number[] = [];
      for (let i = 0; i < count; i++) {
        const raw = BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i]));
        if (raw === FFMPEG_NO_TIMESTAMP) continue;
        ticks.push(Number(raw));
        durations.push(Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i])));
      }
      let prefix = 0;
      const timelineOrigin = firstPresentation?.pts ?? 0;
      while (prefix < ticks.length && ticks[prefix] < timelineOrigin) {
        if (prefix >= 128) throw new MediaOpenError('resource', '视频预滚范围超过 128 帧探测上限。');
        if (!firstPresentation) {
          const extracted = ioCall('vp_extract', 'number', ['number', 'i64'], [ctx, BigInt(ticks[prefix])]);
          if (extracted === 1) break;
          if (extracted !== 2) throw new MediaOpenError('decode', '软件解码器无法解析视频预滚帧。');
        }
        prefix++;
      }
      if (firstPresentation && ticks[prefix] !== timelineOrigin) throw new MediaOpenError('resource', '索引中找不到已展示的首帧时间戳。');
      if (prefix) { ticks.splice(0, prefix); durations.splice(0, prefix); }
      if (!ticks.length) throw new MediaOpenError('decode', '视频只有预滚包，没有可显示的画面。');
      const entry = contexts.get(ctx);
      if (entry) {
        entry.ticks = ticks; entry.durations = durations;
        if (!entry.packets.summary.packetCount) {
          const bytes = core.ccall('vp_index_export_bytes', 'number', ['number'], [ctx]) as number;
          const ptr = core._malloc(bytes) >>> 0;
          if (!ptr) throw new MediaOpenError('resource', 'FFmpeg 包索引内存分配失败。');
          try {
            if (core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, ptr, bytes]) !== count) throw new Error('FFmpeg 包索引导出失败。');
            entry.packets.append(heap().subarray(ptr, ptr + bytes), core.ccall('vp_tb_num', 'number', ['number'], [ctx]), core.ccall('vp_tb_den', 'number', ['number'], [ctx]));
          } finally { core._free(ptr); }
        }
        if (entry.packets.summary.packetCount !== count) throw new Error('FFmpeg 播放与分析索引记录数不一致。');
        entry.indexComplete = true;
      }
      return {
        ...readRecovery(),
        ...decoderConcurrency(core, ctx),
        ctx, path, ticks, durations, analysis: entry?.packets.summary, indexMs: Math.round(performance.now() - indexStart), indexSource,
        localIndexBuildCalls, ioMode, indexIdentity,
        indexTrace: { ...externalIndexTrace, recordImportMs },
        seekAnchorCount: typeof core._vp_index_seek_anchors === 'function' ? core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]) : 0,
        tbNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
        tbDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
        width: core.ccall('vp_width', 'number', ['number'], [ctx]),
        height: core.ccall('vp_height', 'number', ['number'], [ctx]),
        codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
        pixelFormat: typeof core._vp_pixel_format === 'function' ? core.ccall('vp_pixel_format', 'string', ['number'], [ctx]) || null : null,
        colorPrimaries: core.ccall('vp_color_primaries', 'number', ['number'], [ctx]),
        colorTransfer: core.ccall('vp_color_transfer', 'number', ['number'], [ctx]),
        colorSpace: core.ccall('vp_color_space', 'number', ['number'], [ctx]),
        colorRange: core.ccall('vp_color_range', 'number', ['number'], [ctx]),
      };
    };
    const readRecovery = (): FfmpegIndexRecovery => {
      if (typeof core._vp_index_recovery_abi_version !== 'function' || core.ccall('vp_index_recovery_abi_version', 'number', [], []) !== 1)
        throw new MediaOpenError('resource', 'FFmpeg 损坏恢复接口版本不匹配。');
      return core.ccall('vp_index_integrity', 'number', ['number'], [ctx]) ? {
        indexIntegrity: 'prefix', indexTruncatedAt: Number(core.ccall('vp_index_truncated_at', 'i64', ['number'], [ctx])),
        indexEndDts: String(core.ccall('vp_index_end_dts', 'i64', ['number'], [ctx])),
      } : { indexIntegrity: 'complete' };
    };
    const externalIndex = payload.externalIndexSession === true && canImportIndex && Number.isSafeInteger(payload.mediaSize);
    if (payload.externalIndexSession && (!externalIndex || typeof core._vp_prime_first_presentable !== 'function'))
      throw new MediaOpenError('decode', 'WASM core 不支持导入服务端播放索引。');
    if (externalIndex && typeof core._vp_prime_first_presentable === 'function') {
      const primed = ioCall('vp_prime_first_presentable', 'number', ['number'], [ctx]);
      if (primed !== 1) throw new MediaOpenError('decode', 'FFmpeg 无法解出首个可显示画面。');
      firstPresentation = readWasmFrame(core, heap, ctx);
      const firstTicks = firstPresentation.pts;
      const firstDurations = [firstPresentation.duration];
      const indexSink: FfmpegIndexSink = {
        manifest: importRecordManifest,
        batch: importRecordBatch,
        complete: (manifest, frames, trace) => {
          if (frames !== streamedCount) throw new MediaOpenError('resource', '服务端 FFmpeg 索引帧数与导入结果不一致。');
          finishRecordImport(manifest, frames, trace);
          return makeIndexResult(streamedCount, 'server', 0);
        },
        legacy: (index, trace) => {
          externalIndexTrace = trace;
          const parsed = parseFfmpegIndex(index, payload.mediaSize!, {
            codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
            timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
            timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
            width: core.ccall('vp_width', 'number', ['number'], [ctx]),
            height: core.ccall('vp_height', 'number', ['number'], [ctx]),
            streamIndex, indexerBuild,
          });
          if (parsed) {
            const ptr = core._malloc(parsed.records.byteLength) >>> 0;
            if (!ptr) throw new Error('FFmpeg 索引导入内存分配失败。');
            try {
              heap().set(parsed.records, ptr);
              const imported = core.ccall('vp_index_import', 'number', ['number', 'number', 'number'], [ctx, ptr, parsed.document.count]);
              if (imported !== parsed.document.count) throw new MediaOpenError('resource', '服务器索引无法安全导入，已停止这次解码。');
              let expectedAnchors = 0;
              const view = new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength);
              for (let i = 0; i < parsed.document.count; i++) if ((view.getUint32(i * FFMPEG_INDEX_RECORD_BYTES + 36, true) & 2) !== 0) expectedAnchors++;
              if (core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]) !== expectedAnchors) {
                throw new MediaOpenError('resource', '服务器索引的 seek anchor 数量不匹配，已停止这次解码。');
              }
              applyRecovery(parsed.document);
              return makeIndexResult(imported, 'server', 0);
            } finally { core._free(ptr); }
          }
          const built = ioCall('vp_index_build', 'number', ['number'], [ctx]) as number;
          return makeIndexResult(built, 'client', 1);
        },
      };
      contexts.set(ctx, { packets: new FfmpegPacketIndex(), indexComplete: false, ticks: [firstTicks], durations: firstDurations, blobHandle, path, indexSink, tuner });
      const ready: FfmpegInitResult = {
        ...decoderConcurrency(core, ctx),
        ctx, path, ticks: [firstTicks], durations: [firstPresentation.duration],
        firstPts: firstTicks, firstFrame: firstPresentation, indexMs: 0,
        indexSource: 'server', localIndexBuildCalls: 0, ioMode, indexPending: true,
        indexIdentity, indexTrace: externalIndexTrace,
        seekAnchorCount: 0,
        tbNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
        tbDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
        width: core.ccall('vp_width', 'number', ['number'], [ctx]),
        height: core.ccall('vp_height', 'number', ['number'], [ctx]),
        codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
        pixelFormat: typeof core._vp_pixel_format === 'function' ? core.ccall('vp_pixel_format', 'string', ['number'], [ctx]) || null : null,
        colorPrimaries: core.ccall('vp_color_primaries', 'number', ['number'], [ctx]),
        colorTransfer: core.ccall('vp_color_transfer', 'number', ['number'], [ctx]),
        colorSpace: core.ccall('vp_color_space', 'number', ['number'], [ctx]),
        colorRange: core.ccall('vp_color_range', 'number', ['number'], [ctx]),
      };
      onReady?.(ready);
      return ready;
    }
    const count = ioCall('vp_index_build', 'number', ['number'], [ctx]) as number;
    contexts.set(ctx, { packets: new FfmpegPacketIndex(), indexComplete: false, ticks: [], durations: [], blobHandle, path, tuner });
    return makeIndexResult(count, 'client', 1);
  } catch (error) {
    if (contexts.has(ctx)) throw error;
    observations.delete(ctx);
    if (blobHandle) core.vpBlobs.delete(blobHandle);
    try { core.FS.unlink(path); } catch {
      /* best effort */
    }
    core.ccall('vp_destroy', null, ['number'], [ctx]);
    throw error;
  }
}

function extract(ctx: number, index: number, recycle?: ArrayBuffer) {
  const entry = contexts.get(ctx);
  const ticks = entry?.ticks;
  if (!ticks || !Number.isInteger(index) || index < 0 || index >= ticks.length) throw new Error('帧索引无效。');
  const target = BigInt(ticks[index]);
  const result = ioCall('vp_extract', 'number', ['number', 'i64'], [ctx, target]);
  if (result !== 1 || Number(core.ccall('vp_last_ticks', 'i64', ['number'], [ctx])) !== ticks[index]) {
    throw new Error(`WASM 解码未能命中索引帧 ${index}（结果 ${result}）。`);
  }
  return { ...readWasmFrame(core, heap, ctx, recycle),
    seek: typeof core._vp_extract_frames === 'function' ? {
      decodedFrames: core.ccall('vp_extract_frames', 'number', ['number'], [ctx]),
      restarts: core.ccall('vp_extract_restarts', 'number', ['number'], [ctx]),
    } : undefined };
}

/** Reuse the completed index; the old decoder remains intact until the exact
 * requested tick has been decoded by a candidate with its own pthread pool. */
async function restoreThreads(ctx: number, index: number, threads: import('../policy/wasm-threads.ts').DecodeThreads) {
  const entry = contexts.get(ctx), input = coreInput;
  if (!entry?.indexComplete || !input || !Number.isInteger(index) || index < 0 || index >= entry.ticks.length)
    throw new MediaOpenError('input', '线程恢复需要完整索引和有效目标帧。');
  const oldCore = core, oldHeap = heap;
  const bytes = oldCore._vp_index_export_bytes(ctx), ptr = oldCore._malloc(bytes) >>> 0;
  if (bytes <= 0 || !ptr) throw new MediaOpenError('resource', '无法导出线程恢复所需的索引。');
  let records: Uint8Array;
  try {
    if (oldCore._vp_index_export(ctx, ptr, bytes) * FFMPEG_INDEX_RECORD_BYTES !== bytes)
      throw new MediaOpenError('resource', '线程恢复索引导出不完整。');
    records = oldHeap().slice(ptr, ptr + bytes);
  } finally { oldCore._free(ptr); }
  const recovery = { prefix: oldCore._vp_index_integrity(ctx), at: oldCore._vp_index_truncated_at(ctx), end: oldCore._vp_index_end_dts(ctx) };
  const pool = typeof threads === 'number' ? threads : Math.max(threads.general, threads.vvc, threads.vvcTuning?.threads ?? 0);
  const candidate = await loadCore(input.glueURL, input.binary, undefined, pool);
  const next = candidate.core, nextHeap = candidate.heap;
  let nextCtx = 0, committed = false;
  try {
    requireFrameAbi(next);
    next.vpBlobs = new Map();
    next._vp_set_threads(typeof threads === 'number' ? threads : threads.general);
    if (typeof threads === 'object') {
      next._vp_set_vvc_threads?.(threads.vvc);
      next._vp_set_vvc_frame_contexts?.(threads.vvcFrameContexts);
    }
    nextCtx = next.ccall('vp_create', 'number', [], []);
    if (!nextCtx) throw new MediaOpenError('resource', '无法创建线程恢复解码器。');
    if (entry.blobHandle) next.vpBlobs.set(entry.blobHandle, oldCore.vpBlobs.get(entry.blobHandle));
    else next.FS.writeFile(entry.path, oldCore.FS.readFile(entry.path));
    const call = (name: string, result: string | null, types: string[], args: unknown[]) => {
      next.vpDemuxError = undefined;
      const value = next.ccall(name, result, types, args), error = next.vpDemuxError;
      next.vpDemuxError = undefined;
      if (error) throw error;
      return value;
    };
    const opened = entry.blobHandle
      ? call('vp_open_blob', 'number', ['number', 'number', 'i64'], [nextCtx, entry.blobHandle, BigInt(input.size)])
      : call('vp_open', 'number', ['number', 'string'], [nextCtx, entry.path]);
    if (opened !== 0) throw new MediaOpenError('decode', '线程恢复解码器无法打开当前片源。');
    for (const field of ['vp_codec_name', 'vp_tb_num', 'vp_tb_den', 'vp_stream_index']) {
      const result = field === 'vp_codec_name' ? 'string' : 'number';
      if (call(field, result, ['number'], [nextCtx]) !== oldCore.ccall(field, result, ['number'], [ctx]))
        throw new MediaOpenError('input', '线程恢复时片源流信息发生变化。');
    }
    const imported = next._malloc(records.byteLength) >>> 0;
    if (!imported) throw new MediaOpenError('resource', '线程恢复索引内存分配失败。');
    try {
      nextHeap().set(records, imported);
      if (next._vp_index_import(nextCtx, imported, records.byteLength / FFMPEG_INDEX_RECORD_BYTES) * FFMPEG_INDEX_RECORD_BYTES !== records.byteLength)
        throw new MediaOpenError('resource', '线程恢复索引导入不完整。');
      if (recovery.prefix && next.ccall('vp_index_apply_prefix', 'number', ['number', 'i64', 'i64'], [nextCtx, recovery.at, recovery.end]) !== 1)
        throw new MediaOpenError('resource', '线程恢复未能保留索引完整性状态。');
    } finally { next._free(imported); }
    const target = BigInt(entry.ticks[index]);
    if (call('vp_extract', 'number', ['number', 'i64'], [nextCtx, target]) !== 1
      || call('vp_last_ticks', 'i64', ['number'], [nextCtx]) !== target)
      throw new MediaOpenError('decode', '线程恢复未命中原始索引帧。');
    const frame = readWasmFrame(next, nextHeap, nextCtx);
    const observed = observations.get(ctx);
    contexts.delete(ctx); observations.delete(ctx);
    contexts.set(nextCtx, { ...entry, indexSink: undefined });
    if (observed) observations.set(nextCtx, observed);
    for (const alias of contextAliases.keys()) {
      if (alias === nextCtx) contextAliases.delete(alias);
      else contextAliases.set(alias, nextCtx);
    }
    if (ctx !== nextCtx) contextAliases.set(ctx, nextCtx);
    core = next; heap = nextHeap; committed = true;
    oldCore.ccall('vp_destroy', null, ['number'], [ctx]);
    oldCore.vpBlobs.delete(entry.blobHandle);
    try { oldCore.FS.unlink(entry.path); } catch {}
    return { ctx: nextCtx, ...decoderConcurrency(next, nextCtx), frame };
  } finally {
    if (!committed) {
      if (nextCtx) next.ccall('vp_destroy', null, ['number'], [nextCtx]);
      next.vpBlobs?.clear();
      try { next.FS.unlink(entry.path); } catch {}
    }
  }
}

port.onmessage = async (event: { data: Request }) => {
  const message = event.data;
  // Cache/analysis requests may already be in flight when the main thread
  // receives the new context. They still refer to this same immutable source.
  if ('ctx' in message && typeof message.ctx === 'number') message.ctx = contextAliases.get(message.ctx) ?? message.ctx;
  const { id, type } = message;
  if (type === 'peek-audio') {
    const data = observations.get(message.ctx ?? 0)?.peek(message.offset, message.length);
    const windows = message.windows ? observations.get(message.ctx ?? 0)?.cachedWindows() : undefined;
    port.postMessage({ id, type: 'cached-bytes', data, windows }, data ? [data.buffer as ArrayBuffer] : []); return;
  }
  if (type === 'observe-audio') { observations.get(message.ctx)?.setEnabled(message.enabled); return; }
  if (type === 'init') indexRequestId = id;
  let readyContext: number | undefined;
  try {
    if (type === 'init') {
      const result = await init(message, progress => port.postMessage({ id, type: 'progress', progress }), data => {
        readyContext = data.ctx;
        port.postMessage({ id, type: 'ready', data }, [data.firstFrame!.pixels]);
      });
      if (readyContext !== undefined) {
        if (!('indexPending' in result && result.indexPending)) port.postMessage({ id, type: 'index-complete', data: result });
      } else port.postMessage(reply(message, result));
    } else if (type === 'restore-threads') {
      const result = await restoreThreads(message.ctx, message.index, message.threads);
      port.postMessage(reply(message, result), [result.frame.pixels]);
    } else if (type === 'tune-vvc') {
      port.postMessage(reply(message, contexts.get(message.ctx)?.tuner?.tune(message.axis) ?? null));
    } else if (type === 'analysis-ffmpeg-index') {
      const ctx = message.ctx;
      if (!contexts.get(ctx)?.indexComplete) throw new Error('Complete FFmpeg index required');
      const len=core._vp_index_export_bytes(ctx),ptr=core._malloc(len) >>> 0;
      if(len<=0 || !ptr) throw new Error('Invalid FFmpeg index export');
      try {
        const count=core._vp_index_export(ctx,ptr,len);
        if(count*48!==len)throw new Error('Incomplete FFmpeg index export');
        const index=serializeFfmpegIndex({size:message.size,codec:core.ccall('vp_codec_name','string',['number'],[ctx]),
          timeBaseNum:core._vp_tb_num(ctx),timeBaseDen:core._vp_tb_den(ctx),width:core._vp_width(ctx),height:core._vp_height(ctx),
          analysisConfiguration:ffmpegAnalysisConfiguration(core,heap,ctx),streamIndex:core._vp_stream_index(ctx),indexerBuild:core.ccall('vp_core_build_id','string',[],[]),
          ...(core._vp_index_integrity(ctx)?{indexIntegrity:'prefix' as const,indexTruncatedAt:Number(core._vp_index_truncated_at(ctx)),indexEndDts:String(core._vp_index_end_dts(ctx))}:{})},heap().slice(ptr,ptr+len));
        port.postMessage(reply(message,index));
      } finally {core._free(ptr);}
    } else if (type === 'index-input') {
      const ctx = message.ctx;
      const sink = contexts.get(ctx)?.indexSink;
      if (!sink) throw new Error('FFmpeg 索引尚未绑定到媒体容器上下文。');
      let result: FfmpegInitResult | undefined;
      if (message.action === 'manifest') sink.manifest(message.manifest, message.trace);
      else if (message.action === 'batch') sink.batch(message.batch, message.trace);
      else if (message.action === 'complete') result = sink.complete(message.manifest, message.frames, message.trace);
      else if (message.action === 'legacy') result = sink.legacy(message.index, message.trace);
      else throw new Error('未知索引输入');
      if (result) port.postMessage({ id: indexRequestId!, type: 'index-complete', data: result });
    } else if (type === 'analysis' || type === 'analysis-locate' || type === 'analysis-rank' || type === 'analysis-number') {
      const entry = contexts.get(message.ctx);
      if (!entry) throw new Error('媒体已释放。');
      const packets = entry.packets, firstPtsUs = message.firstPtsUs ?? 0, mediaId = message.mediaId ?? '';
      if (type === 'analysis') {
        const result = packets.query({ mediaId, firstPtsUs, durationUs: message.durationUs,
          sourceVersion: '', indexRevision: packets.summary.packetCount,
          capability: { hasSize: true, hasDts: packets.summary.hasDts, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: entry.indexComplete ? 'complete' : 'building' },
          coverageUs: entry.indexComplete ? message.coverageUs : null,
        }, { ...message, requestId: id });
        port.postMessage(reply(message, result));
      } else if (type === 'analysis-locate') port.postMessage(reply(message, packets.locate(mediaId, firstPtsUs, message.sampleId)));
      else if (type === 'analysis-rank') port.postMessage(reply(message, packets.rank(firstPtsUs, message.axis, message.tUs)));
      else port.postMessage(reply(message, packets.sampleAtNumber(firstPtsUs, message.axis, message.number)));
    } else if (type === 'extract') {
      const frame = extract(message.ctx, message.index, message.recycle);
      port.postMessage(reply(message, frame), [frame.pixels]);
    } else if (type === 'dispose') {
      const ctx = message.ctx;
      const entry = contexts.get(ctx);
      if (contexts.delete(ctx)) {
        contextAliases.clear();
        observations.delete(ctx);
        if (entry?.blobHandle) core.vpBlobs.delete(entry.blobHandle);
        try { core.FS.unlink(message.path); } catch {
          /* already gone */
        }
        core.ccall('vp_destroy', null, ['number'], [ctx]);
      }
      port.postMessage(reply(message, null));
    } else {
      throw new Error(`未知消息类型: ${type}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stage = error instanceof MediaOpenError ? error.stage : undefined;
    if (type === 'init' && readyContext !== undefined) {
      port.postMessage({ id, type: 'index-error', data: { ctx: readyContext, error: errorMessage, stage } });
    } else if (type === 'index-input') {
      port.postMessage({ id: indexRequestId!, type: 'index-error', data: { ctx: message.ctx, error: errorMessage, stage } });
    } else {
      port.postMessage({ id, ok: false, error: errorMessage, stage });
    }
  }
};
