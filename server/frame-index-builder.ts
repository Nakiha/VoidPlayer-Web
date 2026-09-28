import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../src/wasm-core.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_SCHEMA, serializeFfmpegIndex } from '../src/ffmpeg-index-cache.ts';
import type { FfmpegIndexDocument } from '../src/ffmpeg-index-cache.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

export function hasServerIndexCore(coreDir: string): boolean {
  return existsSync(path.join(coreDir, 'voidplayer-core.js')) && existsSync(path.join(coreDir, 'voidplayer-core.wasm'));
}

/** Build a cache using local-file AVIO reads; the media itself never enters WASM memory. */
function fileVersion(stat: Stats) {
  return createHash('sha256').update(stat.size + ':' + Math.round(stat.mtimeMs) + ':' + Math.round(stat.ctimeMs) + ':' + stat.ino).digest('hex').slice(0, 24);
}

export interface FfmpegIndexBuildProgress {
  phase: 'scan';
  packets: number;
  scannedBytes: number;
  totalBytes: number;
}

export async function buildFfmpegIndexDocument(
  filePath: string,
  expectedSize: number,
  expectedVersion: string,
  coreDir: string,
  identity: MediaIndexIdentity,
  onProgress?: (progress: FfmpegIndexBuildProgress) => void,
): Promise<FfmpegIndexDocument> {
  if (!hasServerIndexCore(coreDir)) throw new Error('服务端 FFmpeg WASM core 不可用。');
  const stat = statSync(filePath);
  if (!stat || !stat.isFile() || stat.size !== expectedSize || fileVersion(stat) !== expectedVersion) throw new Error('媒体文件在建立索引前已改变。');
  const gluePath = path.join(coreDir, 'voidplayer-core.js');
  const wasmPath = path.join(coreDir, 'voidplayer-core.wasm');
  const wasm = new Uint8Array(await readFile(wasmPath));
  const glue = await import(pathToFileURL(gluePath).href);
  const { core, heap } = await instantiateCore(glue.default, wasm);
  const fd = openSync(filePath, 'r');
  let ctx = 0;
  try {
    core.vpBlobs = new Map();
    if (core.ccall('vp_index_abi_version', 'number', [], []) !== 2
      || core.ccall('vp_index_record_bytes', 'number', [], []) !== FFMPEG_INDEX_RECORD_BYTES) {
      throw new Error('服务端 FFmpeg core 索引 ABI 不匹配。');
    }
    ctx = core.ccall('vp_create', 'number', [], []);
    if (!ctx) throw new Error('服务端无法创建 FFmpeg 索引上下文。');
    const fileSize = stat.size;
    const blob = {
      size: fileSize,
      slice(start: number, end: number) { return { start, end }; },
    };
    const reader = {
      readAsArrayBuffer(range: { start: number; end: number }) {
        const start = Math.max(0, Math.min(fileSize, Math.trunc(range.start)));
        const end = Math.max(start, Math.min(fileSize, Math.trunc(range.end)));
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
    core.vpBlobs.set(ctx, { blob, reader });
    if (core.ccall('vp_open_blob', 'number', ['number', 'number', 'i64'], [ctx, ctx, BigInt(fileSize)]) !== 0) {
      throw new Error('服务端 FFmpeg 无法打开媒体容器。');
    }
    const streamIndex = core.ccall('vp_stream_index', 'number', ['number'], [ctx]) as number;
    const indexerBuild = core.ccall('vp_core_build_id', 'string', [], []) as string;
    if (identity.kind !== 'ffmpeg' || identity.schemaVersion !== FFMPEG_INDEX_SCHEMA
      || identity.streamKey !== `video:${streamIndex}` || identity.indexerBuild !== indexerBuild) {
      throw new Error('媒体索引身份与服务端 FFmpeg core 不匹配。');
    }
    if (core.ccall('vp_index_scan_begin', 'number', ['number'], [ctx]) !== 1) {
      throw new Error('服务端 FFmpeg 无法开始媒体帧索引。');
    }
    while (!core.ccall('vp_index_scan_complete', 'number', ['number'], [ctx])) {
      const step = core.ccall('vp_index_scan_step', 'number', ['number', 'number'], [ctx, 1024]) as number;
      if (step < 0 || core.ccall('vp_index_scan_failed', 'number', ['number'], [ctx])) {
        throw new Error('服务端 FFmpeg 媒体帧索引扫描失败。');
      }
      const packets = core.ccall('vp_index_scan_packets', 'number', ['number'], [ctx]) as number;
      const scannedBytes = Math.min(fileSize, Math.max(0,
        Number(core.ccall('vp_index_scan_bytes', 'i64', ['number'], [ctx]))));
      onProgress?.({ phase: 'scan', packets, scannedBytes, totalBytes: fileSize });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const count = core.ccall('vp_index_count', 'number', ['number'], [ctx]) as number;
    if (count <= 0) throw new Error('服务端 FFmpeg 无法建立媒体帧索引。');
    if (count > 2_000_000) throw new Error('媒体帧数超过服务端索引上限。');
    const recordBytes = core.ccall('vp_index_export_bytes', 'number', ['number'], [ctx]) as number;
    if (recordBytes !== count * FFMPEG_INDEX_RECORD_BYTES) throw new Error('服务端 FFmpeg 索引记录长度异常。');
    const recordPtr = core._malloc(recordBytes);
    if (!recordPtr) throw new Error('服务端 FFmpeg 索引内存分配失败。');
    try {
      const exported = core.ccall('vp_index_export', 'number', ['number', 'number', 'number'], [ctx, recordPtr, recordBytes]) as number;
      if (exported !== count) throw new Error('服务端 FFmpeg 索引导出失败。');
      const records = heap().slice(recordPtr, recordPtr + recordBytes);
      const after = statSync(filePath);
      if (!after || !after.isFile() || after.size !== expectedSize || fileVersion(after) !== expectedVersion) throw new Error('媒体文件在建立索引时已改变。');
      return serializeFfmpegIndex({
        size: fileSize,
        codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
        timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
        timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
        width: core.ccall('vp_width', 'number', ['number'], [ctx]),
        height: core.ccall('vp_height', 'number', ['number'], [ctx]),
        streamIndex,
        indexerBuild,
      }, records);
    } finally { core._free(recordPtr); }
  } finally {
    if (ctx) {
      core.vpBlobs.delete(ctx);
      core.ccall('vp_destroy', null, ['number'], [ctx]);
    }
    closeSync(fd);
  }
}
