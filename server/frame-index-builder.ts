import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../src/wasm-core.ts';
import { serializeFfmpegIndex } from '../src/ffmpeg-index-cache.ts';
import type { FfmpegIndexDocument } from '../src/ffmpeg-index-cache.ts';

export function hasServerIndexCore(coreDir: string): boolean {
  return existsSync(path.join(coreDir, 'voidplayer-core.js')) && existsSync(path.join(coreDir, 'voidplayer-core.wasm'));
}

/** Build a cache using local-file AVIO reads; the media itself never enters WASM memory. */
export async function buildFfmpegIndexDocument(filePath: string, expectedSize: number, coreDir: string): Promise<FfmpegIndexDocument> {
  if (!hasServerIndexCore(coreDir)) throw new Error('服务端 FFmpeg WASM core 不可用。');
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size !== expectedSize) throw new Error('媒体文件在建立索引前已改变。');
  const gluePath = path.join(coreDir, 'voidplayer-core.js');
  const wasmPath = path.join(coreDir, 'voidplayer-core.wasm');
  const wasm = new Uint8Array(await readFile(wasmPath));
  const glue = await import(pathToFileURL(gluePath).href);
  const { core } = await instantiateCore(glue.default, wasm);
  const fd = openSync(filePath, 'r');
  let ctx = 0;
  try {
    core.vpBlobs = new Map();
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
    const count = core.ccall('vp_index_build', 'number', ['number'], [ctx]) as number;
    if (count <= 0) throw new Error('服务端 FFmpeg 无法建立媒体帧索引。');
    if (count > 2_000_000) throw new Error('媒体帧数超过服务端索引上限。');
    const records = Buffer.allocUnsafe(count * 24);
    for (let i = 0; i < count; i++) {
      const offset = i * 24;
      records.writeBigInt64LE(BigInt(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i])), offset);
      records.writeBigInt64LE(BigInt(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i])), offset + 8);
      records.writeUInt32LE(core.ccall('vp_index_is_key', 'number', ['number', 'number'], [ctx, i]) ? 1 : 0, offset + 16);
      records.writeUInt32LE(0, offset + 20);
    }
    return serializeFfmpegIndex({
      size: fileSize,
      codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
      timeBaseNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
      timeBaseDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
      width: core.ccall('vp_width', 'number', ['number'], [ctx]),
      height: core.ccall('vp_height', 'number', ['number'], [ctx]),
    }, new Uint8Array(records.buffer, records.byteOffset, records.byteLength));
  } finally {
    if (ctx) {
      core.vpBlobs.delete(ctx);
      core.ccall('vp_destroy', null, ['number'], [ctx]);
    }
    closeSync(fd);
  }
}
