import { open, stat } from 'node:fs/promises';
import { TsPacketSource } from '../src/ts-packet-source.ts';
import type { TsPacketReader } from '../src/ts-packet-source.ts';
import { fileVersion } from './library.ts';
import { AdminError } from './admin-error.ts';
import type { MediaIndexScanProgress } from '../src/media-index-types.ts';

/** Disk indexing owns no decoder/core; the client and server use the same parser. */
export async function buildJsTsIndexDocument(filePath: string, size: number, version: string, sourceVersion: string,
  onProgress?: (data: MediaIndexScanProgress) => void, signal = new AbortController().signal) {
  const started = performance.now(), cpu = process.cpuUsage(), handle = await open(filePath, 'r');
  let readCalls = 0, readBytes = 0, closed = false;
  const assertVersion = async () => {
    const [opened, current] = await Promise.all([handle.stat(), stat(filePath)]);
    if (opened.size !== size || current.size !== size || fileVersion(opened) !== version || fileVersion(current) !== version)
      throw new AdminError(409, 'TS 文件在索引期间改变，未保存旧版本索引。');
  };
  const blocks = new Map<number, Uint8Array>(), blockBytes = 1024 * 1024;
  const reader: TsPacketReader = { size,
    async read(offset, length) {
      if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || length > 32 * 1024 * 1024 || offset + length > size) throw new AdminError(400, 'TS 磁盘读取范围无效。');
      const bytes = new Uint8Array(length);
      for (let at = offset; at < offset + length;) {
        const start = Math.floor(at / blockBytes) * blockBytes;
        let block = blocks.get(start);
        if (!block) {
          block = new Uint8Array(Math.min(blockBytes, size - start));
          for (let filled = 0; filled < block.length;) {
            const read = await handle.read(block, filled, block.length - filled, start + filled);
            readCalls++; readBytes += read.bytesRead;
            if (!read.bytesRead) throw new AdminError(409, 'TS 文件在索引期间截断或读取不完整。');
            filled += read.bytesRead;
          }
        }
        blocks.delete(start); blocks.set(start, block);
        while (blocks.size > 2) blocks.delete(blocks.keys().next().value!);
        const count = Math.min(block.length - (at - start), offset + length - at);
        bytes.set(block.subarray(at - start, at - start + count), at - offset); at += count;
      }
      return bytes;
    },
    close() { closed = true; blocks.clear(); },
  };
  let source: TsPacketSource | undefined;
  try {
    await assertVersion();
    source = new TsPacketSource(reader, sourceVersion, signal);
    onProgress?.({ packets: 0, scannedBytes: 0, totalBytes: size });
    const document = await source.open(undefined,onProgress);
    await assertVersion();
    onProgress?.({ packets: document.packets.length, scannedBytes: size, totalBytes: size });
    const used = process.cpuUsage(cpu);
    return { document, profile: { scanMode: 'js-ts-packets', totalBuildWallMs: performance.now() - started,
      cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, scannedBytes: size, packets: document.packets.length,
      diskReadCalls: readCalls, diskReadBytes: readBytes } };
  } finally { source?.close(); await handle.close(); }
}
