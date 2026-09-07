import { MediaOpenError } from './media-errors.ts';
import { RangeReader, type RandomAccessInput } from './range-reader.ts';
import { loadAborted, onLoadAbort } from './media-abort.ts';

// Stream types from FFmpeg libavformat/mpegts.h and mpegts.c (ISO/IEC 13818-1).
// 0x06 is private PES, not HEVC. Never infer its codec without descriptors.
const VIDEO_TYPES: Record<number, string> = {
  0x01: 'MPEG-1 Video', 0x02: 'MPEG-2 Video', 0x10: 'MPEG-4 Visual',
  0x1b: 'H.264 / AVC', 0x24: 'H.265 / HEVC', 0x33: 'H.266 / VVC',
  0x42: 'AVS', 0xd2: 'AVS2', 0xd4: 'AVS3', 0xea: 'VC-1',
};

function validCrc(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc === 0;
}

/** Bounded PSI probe, used only to explain a failed open. No decoding or full scan. */
export function probeTsVideo(bytes: Uint8Array): string[] {
  let stride = 0, start = 0;
  for (const size of [188, 192, 204]) {
    for (let offset = 0; offset < size && offset + 2 * size < bytes.length; offset++) {
      if ([0, 1, 2].every(n => bytes[offset + n * size] === 0x47)) { stride = size; start = offset; break; }
    }
    if (stride) break;
  }
  if (!stride) return [];
  const pmtPids = new Set<number>();
  const codecs = new Set<string>();
  const partial = new Map<number, number[]>();
  const continuity = new Map<number, number>();
  const section = (pid: number, data: Uint8Array) => {
    if (data.length < 12 || !(data[1] & 0x80) || !(data[5] & 1) || !validCrc(data)) return;
    const end = data.length - 4;
    if (pid === 0 && data[0] === 0 && (end - 8) % 4 === 0) {
      for (let i = 8; i < end; i += 4) {
        if (data[i] || data[i + 1]) pmtPids.add(((data[i + 2] & 31) << 8) | data[i + 3]);
      }
    } else if (pmtPids.has(pid) && data[0] === 2 && data.length >= 16) {
      let i = 12 + (((data[10] & 15) << 8) | data[11]);
      const found: string[] = [];
      while (i + 5 <= end) {
        const type = data[i], next = i + 5 + (((data[i + 3] & 15) << 8) | data[i + 4]);
        if (next > end) return;
        if (VIDEO_TYPES[type]) found.push(VIDEO_TYPES[type]);
        i = next;
      }
      if (i === end) found.forEach(c => codecs.add(c));
    }
  };
  const feed = (pid: number, data: Uint8Array, fresh: boolean) => {
    let buffer = fresh ? [] : partial.get(pid);
    if (!buffer) return;
    for (const b of data) {
      if (buffer.length === 0 && b === 0xff) break;
      buffer.push(b);
      if (buffer.length < 3) continue;
      const length = 3 + (((buffer[1] & 15) << 8) | buffer[2]);
      if (length < 12 || length > 1024) { buffer = []; break; }
      if (buffer.length === length) { section(pid, Uint8Array.from(buffer)); buffer = []; }
    }
    partial.set(pid, buffer);
  };
  for (let p = start; p + 188 <= bytes.length; p += stride) {
    if (bytes[p] !== 0x47) { partial.clear(); continuity.clear(); continue; }
    const pid = ((bytes[p + 1] & 31) << 8) | bytes[p + 2];
    if (pid !== 0 && !pmtPids.has(pid)) continue;
    const flags = bytes[p + 3], afc = (flags >> 4) & 3;
    if ((bytes[p + 1] & 0x80) || (flags & 0xc0) || afc === 0) { partial.delete(pid); continuity.delete(pid); continue; }
    let payload = p + 4;
    if (afc & 2) {
      const length = bytes[payload];
      if (length && bytes[payload + 1] & 0x80) { partial.delete(pid); continuity.delete(pid); }
      payload += 1 + length;
    }
    if (!(afc & 1) || payload >= p + 188) continue;
    const cc = flags & 15, previous = continuity.get(pid);
    if (previous === cc) continue; // Duplicate retransmission.
    if (previous != null && cc !== ((previous + 1) & 15)) partial.delete(pid);
    continuity.set(pid, cc);
    if (bytes[p + 1] & 0x40) {
      const pointer = bytes[payload++];
      if (payload + pointer > p + 188) { partial.delete(pid); continue; }
      if (pointer) feed(pid, bytes.subarray(payload, payload + pointer), false);
      feed(pid, bytes.subarray(payload + pointer, p + 188), true);
    } else feed(pid, bytes.subarray(payload, p + 188), false);
  }
  return [...codecs];
}

export async function explainMediaFailure(input: RandomAccessInput, nativeError: unknown, fallbackError: unknown, signal?: AbortSignal): Promise<unknown> {
  if (fallbackError instanceof MediaOpenError && ['input', 'resource'].includes(fallbackError.stage)) return fallbackError;
  loadAborted(signal);
  const reader = new RangeReader(input, 64 * 1024);
  const timer = setTimeout(() => reader.close(), 1500);
  const detach = onLoadAbort(signal, () => reader.close());
  try {
    const codecs = probeTsVideo(await reader.read(0, Math.min(reader.size, 64 * 1024)));
    loadAborted(signal);
    if (codecs.length) return new MediaOpenError('codec', `MPEG-TS 声明的视频编码：${codecs.join('、')}。浏览器与当前软件解码器均未能打开；可能是编码/配置不受支持，或码流不完整。`);
  } catch { loadAborted(signal); /* Optional diagnostics never replace the actual failure. */ }
  finally { clearTimeout(timer); detach(); reader.close(); }
  if (nativeError instanceof MediaOpenError && nativeError.stage === 'codec') {
    return new MediaOpenError('codec', `${nativeError.message} 软件回退也未能打开：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
  }
  return fallbackError;
}
