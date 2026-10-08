import { validFfmpegRecovery } from './index-integrity.ts';
import type { FfmpegIndexRecovery } from './index-integrity.ts';
export const FFMPEG_INDEX_SCHEMA = 3;
export const FFMPEG_INDEX_KIND = 'ffmpeg-container';
export const FFMPEG_INDEX_RECORD_BYTES = 48;
export const FFMPEG_INDEX_RECORD_LIMIT = 2_000_000;
// Base64 for two million 48-byte records is about 128 MiB.
export const FFMPEG_INDEX_BYTES = 160 * 1024 * 1024;

export interface FfmpegIndexDocument extends FfmpegIndexRecovery {
  schema: number;
  kind: string;
  size: number;
  codec: string;
  timeBaseNum: number;
  timeBaseDen: number;
  width: number;
  height: number;
  recordBytes: number;
  streamIndex: number;
  indexerBuild: string;
  firstPts?: string;
  originVerified?: boolean;
  count: number;
  records: string;
}
export interface FfmpegIndexMetadata extends FfmpegIndexRecovery {
  size: number;
  codec: string;
  timeBaseNum: number;
  timeBaseDen: number;
  width: number;
  height: number;
  streamIndex: number;
  indexerBuild: string;
  firstPts?: string;
  originVerified?: boolean;
}
export interface ParsedFfmpegIndex {
  document: FfmpegIndexDocument;
  records: Uint8Array;
}

export function encodeBase64(bytes: Uint8Array): string {
  let encoded = '';
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let binary = '';
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
    encoded += btoa(binary);
  }
  return encoded;
}

export function serializeFfmpegIndex(metadata: FfmpegIndexMetadata, records: Uint8Array): FfmpegIndexDocument {
  if (records.byteLength === 0 || records.byteLength % FFMPEG_INDEX_RECORD_BYTES !== 0) throw new Error('FFmpeg 索引记录长度无效。');
  const count = records.byteLength / FFMPEG_INDEX_RECORD_BYTES;
  const encoded = encodeBase64(records);
  if (count > FFMPEG_INDEX_RECORD_LIMIT || encoded.length > FFMPEG_INDEX_BYTES) throw new Error('FFmpeg 索引超过缓存上限。');
  return {
    schema: FFMPEG_INDEX_SCHEMA, kind: FFMPEG_INDEX_KIND, ...metadata,
    recordBytes: FFMPEG_INDEX_RECORD_BYTES, count, records: encoded,
  };
}

export function parseFfmpegIndex(value: unknown, size: number, expected?: Partial<FfmpegIndexMetadata>): ParsedFfmpegIndex | null {
  const doc = value as FfmpegIndexDocument | null;
  if (!doc || !validFfmpegRecovery(doc, size) || doc.schema !== FFMPEG_INDEX_SCHEMA || doc.kind !== FFMPEG_INDEX_KIND || doc.size !== size
    || typeof doc.codec !== 'string' || !/^[a-z0-9_+-]{1,64}$/i.test(doc.codec)
    || !Number.isSafeInteger(doc.timeBaseNum) || doc.timeBaseNum <= 0 || doc.timeBaseNum > 1_000_000_000
    || !Number.isSafeInteger(doc.timeBaseDen) || doc.timeBaseDen <= 0 || doc.timeBaseDen > 1_000_000_000
    || !Number.isSafeInteger(doc.width) || doc.width <= 0 || doc.width > 16384
    || !Number.isSafeInteger(doc.height) || doc.height <= 0 || doc.height > 16384
    || !Number.isSafeInteger(doc.streamIndex) || doc.streamIndex < 0 || doc.streamIndex > 64
    || typeof doc.indexerBuild !== 'string' || !/^[a-f0-9]{40}$/.test(doc.indexerBuild)
    || (doc.firstPts !== undefined && (typeof doc.firstPts !== 'string' || !/^-?\d+$/.test(doc.firstPts)))
    || (doc.originVerified !== undefined && typeof doc.originVerified !== 'boolean')
    || doc.recordBytes !== FFMPEG_INDEX_RECORD_BYTES
    || !Number.isSafeInteger(doc.count) || doc.count <= 0 || doc.count > FFMPEG_INDEX_RECORD_LIMIT
    || typeof doc.records !== 'string' || doc.records.length > FFMPEG_INDEX_BYTES
    || doc.records.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(doc.records)) return null;
  for (const key of ['codec', 'timeBaseNum', 'timeBaseDen', 'width', 'height', 'streamIndex', 'indexerBuild'] as const) {
    if (expected?.[key] !== undefined && expected[key] !== doc[key]) return null;
  }
  let binary: string;
  try { binary = atob(doc.records); } catch { return null; }
  const records = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) records[i] = binary.charCodeAt(i);
  if (records.byteLength !== doc.count * FFMPEG_INDEX_RECORD_BYTES || records.byteLength > FFMPEG_INDEX_BYTES) return null;
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  let previous: bigint | undefined;
  let unknownPts = false;
  const ordinals = new Set<bigint>();
  const noTimestamp = -9223372036854775808n;
  for (let i = 0; i < doc.count; i++) {
    const offset = i * FFMPEG_INDEX_RECORD_BYTES;
    const pts = view.getBigInt64(offset, true);
    const dts = view.getBigInt64(offset + 8, true);
    const pos = view.getBigInt64(offset + 24, true);
    const packetSize = view.getInt32(offset + 32, true);
    const flags = view.getUint32(offset + 36, true);
    const ordinal = view.getBigUint64(offset + 40, true);
    if (doc.indexIntegrity === 'prefix' && (pts === noTimestamp || dts === noTimestamp || dts > BigInt(doc.indexEndDts!))) return null;
    const key = (flags & 1) !== 0;
    const seekAnchor = (flags & 2) !== 0;
    if (packetSize < 0 || pos < -1n || (flags & ~3) !== 0
      || ordinal >= BigInt(FFMPEG_INDEX_RECORD_LIMIT) || ordinals.has(ordinal)
      || (seekAnchor && (!key || pos < 0n || pts === noTimestamp || dts === noTimestamp))
      || (pts !== noTimestamp && (unknownPts || (previous !== undefined && pts < previous)))) return null;
    ordinals.add(ordinal);
    if (pts === noTimestamp) unknownPts = true; else previous = pts;
  }
  return { document: doc, records };
}

/** Signed timestamp sentinel is kept out of arithmetic and playback views. */
export const FFMPEG_NO_TIMESTAMP = -9223372036854775808n;
export function ffmpegTicksToUs(ticks: bigint, num: number, den: number): number {
  const numerator = ticks * BigInt(num) * 1_000_000n, divisor = BigInt(den);
  let rounded = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder * 2n >= divisor) rounded++;
  else if (remainder * 2n < -divisor) rounded--;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new Error('FFmpeg 时间戳超出安全范围。');
  return value;
}
/** The frontier ignores untimed records at the tail of the shared packet index. */
export function lastFfmpegPts(records: Uint8Array, previous: bigint = FFMPEG_NO_TIMESTAMP): bigint {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  for (let offset = 0; offset < records.byteLength; offset += FFMPEG_INDEX_RECORD_BYTES) {
    const pts = view.getBigInt64(offset, true);
    if (pts !== FFMPEG_NO_TIMESTAMP) previous = pts;
  }
  return previous;
}
