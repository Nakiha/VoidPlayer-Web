import { rangeBlobReader } from './range-bridge-reader.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { randomUUID } from './uuid.ts';
import { loadCore } from './wasm-core.ts';
import { readWasmFrame, requireFrameAbi } from './wasm-frame.ts';
import { MediaIndexClient } from './media-index-client.ts';
import type { MediaIndexRecordBatch, MediaIndexRecordManifest, MediaIndexScanProgress } from './media-index-types.ts';
import { FFMPEG_INDEX_BYTES, FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_SCHEMA, parseFfmpegIndex, serializeFfmpegIndex } from './ffmpeg-index-cache.ts';
// Web Worker hosting the self-built FFmpeg WASM core. Decoding is synchronous
// CPU work; it must never run on the UI thread. The page talks to this worker
// over a small RPC: init (open + demux-only index) and extract (exact-PTS RGBA
// frame). Pixel buffers are transferred, never copied.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Dual environment: web worker (browser) and node:worker_threads (tests).
// Messages queue until the initial script evaluation completes in both
// environments, so wiring the listener from a microtask is race-free.
const port: any = (() => {
  const scope = globalThis as any;
  if (!scope.process?.versions?.node) return scope;
  const shim: { onmessage: null | ((event: { data: any }) => void) } = { onmessage: null };
  let parent: any = null;
  void import('node:worker_threads').then(({ parentPort }) => {
    if (!parentPort) throw new Error('worker_threads parentPort 不可用');
    parent = parentPort;
    parentPort.on('message', (data: any) => shim.onmessage?.({ data }));
  });
  return {
    get onmessage() { return shim.onmessage; },
    set onmessage(fn) { shim.onmessage = fn; },
    postMessage: (message: any, transfer?: any[]) => parent?.postMessage(message, transfer),
  };
})();

let core: any = null;
let heap: () => Uint8Array;
let indexRequestId: number | undefined;
const contexts = new Map<number, { ticks: number[]; durations: number[]; blobHandle: number; path: string; indexClient?: MediaIndexClient }>();

async function init(payload: { glueURL: string; wasmBinary: ArrayBuffer; name: string; file?: ArrayBuffer; blob?: Blob; range?: { shared: SharedArrayBuffer; size: number }; threads?: number; indexUrl?: string; mediaSize?: number }, onProgress: MediaOpenProgress, onReady?: (data: any) => void, onIndexProgress?: (progress: MediaIndexScanProgress) => void) {
  onProgress('decoder');
  ({ core, heap } = await loadCore(payload.glueURL, payload.wasmBinary ? new Uint8Array(payload.wasmBinary) : undefined));
  requireFrameAbi(core);
  core.vpBlobs = new Map();
  const ctx = core.ccall('vp_create', 'number', [], []);
  if (!ctx) throw new Error('无法创建 WASM 解码上下文。');
  const path = `/vp-in-${randomUUID()}`;
  let blobHandle = 0;
  let indexClient: MediaIndexClient | undefined;
  let firstPresentation: ReturnType<typeof readWasmFrame> | undefined;
  try {
    // Player-assigned decode thread budget (no-op on the single-thread core).
    if (payload.threads) core.ccall('vp_set_threads', null, ['number'], [payload.threads]);
    // Blobs read on demand through the custom AVIO (FileReaderSync chunks), so
    // no whole-file copy ever enters WASM memory. Node workers lack
    // FileReaderSync and buffer the bytes once (capped) into MEMFS.
    onProgress('inspect');
    let ioMode = 'memfs';
    if (payload.range) {
      ioMode = 'http-range'; blobHandle = ctx;
      const { shared, size } = payload.range;
      core.vpBlobs.set(blobHandle, rangeBlobReader(shared, size, message => port.postMessage(message)));
      if (core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, blobHandle, BigInt(size)]) !== 0) {
        throw new MediaOpenError('container', '软件解码器未能打开视频轨道：封装、编码可能不受支持，或文件数据不完整。');
      }
    } else if (payload.blob && typeof FileReaderSync !== 'undefined') {
      ioMode = 'blob';
      blobHandle = ctx; // the ctx pointer is already a unique id per context
      core.vpBlobs.set(blobHandle, { blob: payload.blob, reader: new FileReaderSync() });
      if (core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, blobHandle, BigInt(payload.blob.size)]) !== 0) {
        throw new MediaOpenError('container', '软件解码器未能打开视频轨道：封装、编码可能不受支持，或文件数据不完整。');
      }
    } else {
      const bytes = payload.file ?? await payload.blob?.arrayBuffer();
      if (!bytes) throw new Error('缺少媒体数据。');
      if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('文件超过 WASM 回退解码的内存上限。');
      core.FS.writeFile(path, new Uint8Array(bytes));
      if (core.ccall('vp_open', 'number', ['number', 'string'], [ctx, path]) !== 0) {
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
      && core.ccall('vp_index_abi_version', 'number', [], []) === 2
      && typeof core._vp_index_stream_abi_version === 'function'
      && core.ccall('vp_index_stream_abi_version', 'number', [], []) === 1
      && typeof core._vp_index_import_begin === 'function'
      && typeof core._vp_index_import_batch === 'function'
      && core.ccall('vp_index_record_bytes', 'number', [], []) === FFMPEG_INDEX_RECORD_BYTES;
    let streamImportStarted = false;
    let streamImportComplete = false;
    let streamedBuildId = '';
    let streamedCount = 0;
    let streamedLastSeq = -1;
    let streamedSafeTick = 0n;
    let originRecordSkipped = false;
    let recordImportMs = 0;
    const importRecordManifest = (manifest: MediaIndexRecordManifest) => {
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
    const importRecordBatch = (batch: MediaIndexRecordBatch) => {
      if (!firstPresentation || !streamedBuildId || batch.buildId !== streamedBuildId) throw new MediaOpenError('resource', 'FFmpeg 索引 batch 不属于当前 build。');
      if (!streamImportStarted) {
        if (core.ccall('vp_index_import_begin', 'number', ['number'], [ctx]) !== 1) throw new MediaOpenError('resource', 'FFmpeg 无法开始渐进导入服务端索引。');
        streamImportStarted = true;
      }
      const view = new DataView(batch.records.buffer, batch.records.byteOffset, batch.records.byteLength);
      const safeTick = view.getBigInt64(batch.records.byteLength - FFMPEG_INDEX_RECORD_BYTES, true);
      const ptr = core._malloc(batch.records.byteLength);
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
      const newTicks: number[] = [], newDurations: number[] = [];
      for (let i = previousCount; i < streamedCount; i++) {
        const tick = Number(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i]));
        const duration = Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i]));
        if (tick < firstPresentation.pts) continue;
        if (!originRecordSkipped && tick === firstPresentation.pts) { originRecordSkipped = true; continue; }
        newTicks.push(tick);
        newDurations.push(duration);
      }
      entry.ticks.push(...newTicks);
      entry.durations.push(...newDurations);
      const timeBaseNum = core.ccall('vp_tb_num', 'number', ['number'], [ctx]) as number;
      const timeBaseDen = core.ccall('vp_tb_den', 'number', ['number'], [ctx]) as number;
      const toUs = (value: number) => Math.round(value * 1e6 * timeBaseNum / timeBaseDen);
      const lastDuration = Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, streamedCount - 1]));
      const durationCoverageUs = lastDuration > 0 ? Math.max(1, toUs(lastDuration)) : 1;
      const stableCoverageUs = Math.max(1, toUs(Number(safeTick) - firstPresentation.pts) + durationCoverageUs);
      port.postMessage({ id: indexRequestId, type: 'index-batch', data: { ctx, ticks: newTicks, durations: newDurations,
        stableCoverageUs, seekAnchorCount: core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]), buildId: streamedBuildId,
        indexIdentity, indexTrace: { ...indexClient?.diagnostics(), recordImportMs } } });
    };
    const finishRecordImport = (_manifest: MediaIndexRecordManifest, _frames: number) => {
      if (!streamImportStarted || streamImportComplete) return;
      const result = core.ccall('vp_index_import_batch', 'number', ['number', 'number', 'number', 'number', 'i64', 'number'],
        [ctx, 0, 0, streamedLastSeq + 1, streamedSafeTick, 1]) as number;
      if (result !== 0) throw new MediaOpenError('resource', 'FFmpeg 无法完成服务端索引导入。');
      streamImportComplete = true;
    };
    indexClient = payload.indexUrl && Number.isSafeInteger(payload.mediaSize) && canImportIndex
      ? new MediaIndexClient(payload.indexUrl, 'ffmpeg', FFMPEG_INDEX_BYTES + 1024, 120000, true, indexIdentity,
        progress => onIndexProgress?.(progress), importRecordManifest, importRecordBatch, finishRecordImport) : undefined;
    if (indexClient && typeof core._vp_prime_first_presentable === 'function') {
      const primed = core.ccall('vp_prime_first_presentable', 'number', ['number'], [ctx]);
      if (primed !== 1) throw new MediaOpenError('decode', 'FFmpeg 无法解出首个可显示画面。');
      firstPresentation = readWasmFrame(core, heap, ctx);
      const firstTicks = firstPresentation.pts;
      contexts.set(ctx, { ticks: [firstTicks], durations: [firstPresentation.duration], blobHandle, path, indexClient });
      onReady?.({
        ctx, path, ticks: [firstTicks], durations: [firstPresentation.duration],
        firstPts: firstTicks, firstFrame: firstPresentation, indexMs: 0,
        indexSource: 'server', localIndexBuildCalls: 0, ioMode,
        indexIdentity, indexTrace: { ...indexClient.diagnostics(), recordImportMs },
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
      });
    }
    let indexSource: 'server' | 'client' = 'client';
    let localIndexBuildCalls = 0;
    let count = 0;
    if (indexClient && canImportIndex) {
      try {
        const cached = await indexClient.read();
        const streamResult = cached as { streamed?: unknown; count?: unknown } | null;
        if (streamResult?.streamed === true) {
          if (!streamImportComplete || streamedCount !== streamResult.count) throw new MediaOpenError('resource', '服务端索引流未完整导入。');
          count = streamedCount;
          indexSource = 'server';
        } else if (!cached && streamImportStarted) {
          throw new MediaOpenError('resource', '服务端索引流中断；已保留稳定前缀，未将其当作完整索引。');
        }
        const parsed = streamResult?.streamed === true ? null : parseFfmpegIndex(cached, payload.mediaSize!, {
          codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
          timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
          timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
          width: core.ccall('vp_width', 'number', ['number'], [ctx]),
          height: core.ccall('vp_height', 'number', ['number'], [ctx]),
          streamIndex,
          indexerBuild,
        });
        if (parsed) {
          const ptr = core._malloc(parsed.records.byteLength);
          if (!ptr) throw new Error('FFmpeg 索引导入内存分配失败。');
          try {
            heap().set(parsed.records, ptr);
            const recordView = new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength);
            let expectedSeekAnchors = 0;
            for (let i = 0; i < parsed.document.count; i++) {
              if ((recordView.getUint32(i * FFMPEG_INDEX_RECORD_BYTES + 36, true) & 2) !== 0) expectedSeekAnchors++;
            }
            const imported = core.ccall('vp_index_import', 'number', ['number', 'number', 'number'], [ctx, ptr, parsed.document.count]);
            if (imported !== parsed.document.count) throw new MediaOpenError('resource', '服务器索引无法安全导入，已停止这次解码。');
            const importedSeekAnchors = core.ccall('vp_index_seek_anchors', 'number', ['number'], [ctx]) as number;
            if (importedSeekAnchors !== expectedSeekAnchors) throw new MediaOpenError('resource', '服务器索引的 seek anchor 数量不匹配，已停止这次解码。');
            count = imported;
            indexSource = 'server';
          } finally { core._free(ptr); }
        }
      } catch (error) {
        if (error instanceof MediaOpenError) throw error;
        /* An unavailable or stale server index falls back to local indexing. */
      }
    }
    if (!count) {
      localIndexBuildCalls++;
      count = core.ccall('vp_index_build', 'number', ['number'], [ctx]) as number;
    }
    if (count <= 0) { indexClient?.close(); throw new Error('FFmpeg WASM 无法建立该文件的帧索引。'); }
    const indexMs = Math.round(performance.now() - indexStart);
    const ticks: number[] = new Array(count);
    const durations: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      ticks[i] = Number(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i]));
      durations[i] = Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i]));
    }
    // MP4 edit lists may keep negative-time discard/pre-roll packets in the
    // demux index. Keep them in the core for decoding, but do not expose an
    // unrenderable prefix as frame zero. Never skip a positive-time failure.
    let prefix = 0;
    const timelineOrigin = firstPresentation?.pts ?? 0;
    while (prefix < ticks.length && ticks[prefix] < timelineOrigin) {
      if (prefix >= 128) throw new MediaOpenError('resource', '视频预滚范围超过 128 帧探测上限。');
      if (!firstPresentation) {
        const result = core.ccall('vp_extract', 'number', ['number', 'i64'], [ctx, BigInt(ticks[prefix])]);
        if (result === 1) break;
        if (result !== 2) throw new MediaOpenError('decode', '软件解码器无法解析视频预滚帧。');
      }
      prefix++;
    }
    if (firstPresentation && ticks[prefix] !== timelineOrigin) {
      throw new MediaOpenError('resource', '索引中找不到已展示的首帧时间戳。');
    }
    if (prefix) { ticks.splice(0, prefix); durations.splice(0, prefix); }
    if (!ticks.length) throw new MediaOpenError('decode', '视频只有预滚包，没有可显示的画面。');
    if (indexSource === 'client' && indexClient && canImportIndex) {
      try {
        const recordBytes = core.ccall('vp_index_export_bytes', 'number', ['number'], [ctx]) as number;
        if (recordBytes !== count * FFMPEG_INDEX_RECORD_BYTES) throw new Error('FFmpeg 索引记录长度异常。');
        const recordPtr = core._malloc(recordBytes);
        if (!recordPtr) throw new Error('FFmpeg 索引导出内存分配失败。');
        try {
          const exported = core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, recordPtr, recordBytes]);
          if (exported !== count) throw new Error('FFmpeg 索引导出失败。');
          const records = heap().slice(recordPtr, recordPtr + recordBytes);
          const document = serializeFfmpegIndex({
            size: payload.mediaSize!,
            codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
            timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
            timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
            width: core.ccall('vp_width', 'number', ['number'], [ctx]),
            height: core.ccall('vp_height', 'number', ['number'], [ctx]),
            streamIndex,
            indexerBuild,
            firstPts: String(firstPresentation?.pts ?? ticks[0]),
            originVerified: !!firstPresentation,
          }, records);
          void indexClient.save(document).catch(() => {});
        } finally { core._free(recordPtr); }
      } catch { /* An oversized or unsupported index must not block playback. */ }
    }
    contexts.set(ctx, { ticks, durations, blobHandle, path, indexClient });
    return {
      ctx, path, ticks, durations, indexMs, indexSource, localIndexBuildCalls, ioMode,
      indexIdentity, indexTrace: { ...indexClient?.diagnostics(), recordImportMs },
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
  } catch (error) {
    if (firstPresentation) {
      indexClient?.close();
      // The early-ready source owns this context until it is explicitly disposed.
      const entry = contexts.get(ctx);
      if (entry) entry.indexClient = indexClient;
      throw error;
    }
    if (blobHandle) core.vpBlobs.delete(blobHandle);
    indexClient?.close();
    try { core.FS.unlink(path); } catch { /* best effort */ }
    core.ccall('vp_destroy', null, ['number'], [ctx]);
    throw error;
  }
}

function extract(ctx: number, index: number, recycle?: ArrayBuffer) {
  const entry = contexts.get(ctx);
  const ticks = entry?.ticks;
  if (!ticks || !Number.isInteger(index) || index < 0 || index >= ticks.length) throw new Error('帧索引无效。');
  const target = BigInt(ticks[index]);
  const result = core.ccall('vp_extract', 'number', ['number', 'i64'], [ctx, target]);
  if (result !== 1 || Number(core.ccall('vp_last_ticks', 'i64', ['number'], [ctx])) !== ticks[index]) {
    throw new Error(`WASM 解码未能命中索引帧 ${index}（结果 ${result}）。`);
  }
  return { ...readWasmFrame(core, heap, ctx, recycle),
    seek: typeof core._vp_extract_frames === 'function' ? {
      decodedFrames: core.ccall('vp_extract_frames', 'number', ['number'], [ctx]),
      restarts: core.ccall('vp_extract_restarts', 'number', ['number'], [ctx]),
    } : undefined };
}

port.onmessage = async (event: { data: any }) => {
  const { id, type, ...payload } = event.data;
  if (type === 'init') indexRequestId = id;
  let readyContext: number | undefined;
  try {
    if (type === 'init') {
      const result = await init(payload, progress => port.postMessage({ id, type: 'progress', progress }), data => {
        readyContext = data.ctx;
        port.postMessage({ id, type: 'ready', data }, [data.firstFrame.pixels]);
      }, progress => port.postMessage({ id, type: 'index-progress', data: progress }));
      if (readyContext !== undefined) port.postMessage({ id, type: 'index-complete', data: result });
      else port.postMessage({ id, ok: true, data: result });
    } else if (type === 'extract') {
      const frame = extract(payload.ctx, payload.index, payload.recycle);
      port.postMessage({ id, ok: true, data: frame }, [frame.pixels]);
    } else if (type === 'dispose') {
      const ctx = payload.ctx;
      const entry = contexts.get(ctx);
      if (contexts.delete(ctx)) {
        if (entry?.blobHandle) core.vpBlobs.delete(entry.blobHandle);
        entry?.indexClient?.close();
        try { core.FS.unlink(payload.path); } catch { /* already gone */ }
        core.ccall('vp_destroy', null, ['number'], [ctx]);
      }
      port.postMessage({ id, ok: true, data: null });
    } else {
      throw new Error(`未知消息类型: ${type}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = error instanceof MediaOpenError ? error.stage : undefined;
    if (type === 'init' && readyContext !== undefined) {
      port.postMessage({ id, type: 'index-error', data: { ctx: readyContext, error: message, stage } });
    } else {
      port.postMessage({ id, ok: false, error: message, stage });
    }
  }
};
