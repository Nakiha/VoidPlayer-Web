import { open, stat } from 'node:fs/promises';
import { fileVersion } from './library.ts';
import { AdminError } from './admin-error.ts';
import { inspectMp4Playback } from '../shared/media/containers/mp4-playback.ts';
import { serializeMp4Playback } from '../shared/media/indexing/mp4-playback-index.ts';
import type { MediaIndexScanProgress } from '../shared/media/indexing/media-index-types.ts';

export async function buildMp4PlaybackDocument(filePath: string, size: number, version: string, sourceVersion: string,
  progress: (data: MediaIndexScanProgress) => void) {
  const handle = await open(filePath, 'r');
  try {
    const verify = async () => {
      const [opened, current] = await Promise.all([handle.stat(), stat(filePath)]);
      if (!opened.isFile() || !current.isFile() || opened.size !== size || current.size !== size
        || fileVersion(opened) !== version || fileVersion(current) !== version)
        throw new AdminError(409, 'MP4 文件在索引期间改变。');
    };
    await verify();
    let reads = 0, scannedBytes = 0;
    const read = async (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || length > 64 * 1024 * 1024 || length > size - offset) throw new AdminError(400, 'MP4 磁盘读取范围无效。');
      const bytes = new Uint8Array(length);
      for (let filled = 0; filled < length;) {
        const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled);
        if (!bytesRead) throw new AdminError(409, 'MP4 文件在索引期间截断。');
        filled += bytesRead;
      }
      scannedBytes += length;
      if (++reads % 64 === 0) progress({ packets: 0, scannedBytes: Math.min(size, scannedBytes), totalBytes: size });
      return bytes;
    };
    const playback = await inspectMp4Playback({ size, read });
    await verify();
    progress({ packets: playback.index.packets.length, scannedBytes: size, totalBytes: size });
    return serializeMp4Playback(playback, size, sourceVersion);
  } finally { await handle.close(); }
}
