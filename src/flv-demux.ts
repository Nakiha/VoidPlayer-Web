import { hevcGeometry } from './hevc-geometry.ts';
import { RangeReader } from './range-reader.ts';
import type { RangeVersion } from './range-reader.ts';
import { MediaOpenError } from './media-errors.ts';

export type FlvInput = { file: Blob } | { url: string; size: number };
export type FlvCodec = 'h264' | 'hevc' | 'av1' | 'vvc';
export interface FlvPacket { sequenceNumber?:number; configuration?: number; offset: number; size: number; pts: number; dts: number; key: boolean; originalPts?: number; }
export interface FlvIndex {
  configurations?: Uint8Array[]; // Configuration records in decode-order segments.
  truncatedAt?: number; // Start of an incomplete trailing tag, never a playable packet.
  codec: FlvCodec;
  description: Uint8Array;
  packets: FlvPacket[]; // decode order; payloads stay in the source
  order: number[]; // presentation order
  firstPts: number; // Earliest indexed presentation PTS, not the media timeline origin.
  duration: number;
  durations: number[];
}
const bad = (message: string): never => { throw new MediaOpenError('container', `FLV：${message}`); };
const u24 = (b: Uint8Array, i: number) => b[i] * 65536 + b[i + 1] * 256 + b[i + 2];
const u32 = (b: Uint8Array, i: number) => b[i] * 16777216 + u24(b, i + 1);
const s24 = (b: Uint8Array, i: number) => (u24(b, i) << 8) >> 8;

/** Private-CDN and Enhanced FLV share bounded, cancellable HTTP Range IO. */
export class FlvReader extends RangeReader {
  constructor(input: FlvInput, version?: RangeVersion) { super(input, 64 * 1024, version); }
  setIndexing(indexing: boolean) { this.setReadAheadBlocks(indexing && 'url' in this.input ? 16 : 1); }
  override async read(offset: number, length: number): Promise<Uint8Array> {
    try { return await super.read(offset, length); }
    catch (error) {
      if (error instanceof MediaOpenError) throw new MediaOpenError(error.stage, `FLV：${error.message}`);
      throw error;
    }
  }
}

/** Standard AVC, legacy CDN HEVC/AV1/VVC and single-track Enhanced FLV.
 * Audio/script tags are skipped: this review app currently has video only. */
export interface FlvCheckpoint { index: FlvIndex; nextOffset: number; complete: boolean; }

export async function demuxFlv(reader: FlvReader, onProgress?: () => void): Promise<FlvIndex> {
  return (await scanFlv(reader, onProgress)).index;
}

/** Stop after the first video packet for startup; resume at the next tag. */
export async function scanFlv(reader: FlvReader, onProgress?: () => void, resume?: FlvCheckpoint, firstPacket = false, publish?: (checkpoint: FlvCheckpoint) => void): Promise<FlvCheckpoint> {
  const header = await reader.read(0, 9);
  if (header[0] !== 70 || header[1] !== 76 || header[2] !== 86 || header[3] !== 1) bad('不是有效的 FLV 1 文件。');
  let offset = u32(header, 5);
  if (offset < 9 || offset + 4 > reader.size) bad('文件头长度无效。');
  if (u32(await reader.read(offset, 4), 0) !== 0) bad('首个 PreviousTagSize 无效。');
  offset += 4;
  if (resume) offset = resume.nextOffset;
  let codec: FlvCodec | undefined = resume?.index.codec;
  let description: Uint8Array | undefined = resume?.index.description;
  const configurations = resume?.index.configurations?.slice() ?? (description ? [description] : []);
  let configuration = configurations.length - 1;
  const packets: FlvPacket[] = resume ? resume.index.packets.slice() : [];
  let truncatedAt: number | undefined;
  let reported = performance.now();
  let published = resume?.index;
  const checkpoint = (nextOffset: number, complete: boolean) => {
    // Sort only newly discovered packets, then merge with the existing order.
    const index = extendFlvIndex(published, codec, description, packets, configurations);
    published = index;
    return { index, nextOffset, complete };
  };
  let publicationFailure: unknown;
  let publishedOffset = resume?.nextOffset ?? offset;
  const publishProgress = () => {
    if (!publish || !packets.length || offset <= publishedOffset || publicationFailure) return;
    try { publish(checkpoint(offset, false)); publishedOffset = offset; onProgress?.(); }
    catch (error) { publicationFailure = error; }
  };
  // Publish the validated prefix even if the next HTTP read is still pending.
  // Never emit heartbeats for unchanged bytes: stalled IO must still time out.
  const timer = publish ? setInterval(publishProgress, 500) : undefined;
  try {
  while (offset < reader.size) {
    if (publicationFailure) throw publicationFailure;
    if (performance.now() - reported >= 500) {
      onProgress?.();
      publishProgress();
      if (publicationFailure) throw publicationFailure;
      reported = performance.now();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (reader.size - offset < 11) { truncatedAt = offset; break; }
    const tag = await reader.read(offset, 11);
    const size = u24(tag, 1), start = offset + 11, next = start + size + 4;
    if (u24(tag, 8) !== 0) bad(`标签 @${offset} 的 stream ID 无效。`);
    if (next > reader.size) {
      if (![8, 9, 18].includes(tag[0])) bad(`末尾标签 @${offset} 的类型或标志无效，且长度超出文件末尾。`);
      truncatedAt = offset; break;
    }
    if (u32(await reader.read(next - 4, 4), 0) !== size + 11) bad('PreviousTagSize 与标签长度不一致。');
    if ((tag[0] & 31) === 9) {
      if (tag[0] & 0xe0) bad('不支持加密或扩展标签标志。');
      if (size < 1) bad('视频标签为空。');
      const b = await reader.read(start, Math.min(size, 8));
      const flags = b[0], enhanced = !!(flags & 0x80), frameType = (flags >> 4) & 7;
      if (frameType < 1 || frameType > 5) bad('视频帧类型无效。');
      if (frameType === 5) { offset = next; continue; } // video command, no picture
      let current: FlvCodec | undefined, type: number, skip: number, cts = 0;
      if (enhanced) {
        type = flags & 15;
        if (type === 4) { offset = next; continue; } // metadata, not a coded picture
        if (![0, 1, 2, 3].includes(type)) bad('暂不支持 Enhanced FLV 多轨或扩展包类型。');
        if (size < 5) bad('Enhanced 视频头被截断。');
        const fourcc = String.fromCharCode(...b.subarray(1, 5));
        current = ({ avc1: 'h264', hvc1: 'hevc', av01: 'av1', vvc1: 'vvc' } as Record<string, FlvCodec>)[fourcc];
        skip = 5;
        // AV1 packets have no composition-time field in Enhanced FLV.
        if (type === 1 && current !== 'av1') { if (size < 8) bad('缺少 composition time。'); cts = s24(b, 5); skip = 8; }
      } else {
        current = ({ 7: 'h264', 12: 'hevc', 13: 'av1', 14: 'vvc' } as Record<number, FlvCodec>)[flags & 15];
        if (size < 5) bad('视频头被截断。');
        type = b[1]; skip = 5; cts = s24(b, 2);
        if (![0, 1, 2].includes(type)) bad('未知视频包类型。');
      }
      if (!current) throw new MediaOpenError('codec', 'FLV 视频编码暂不支持（支持 AVC、HEVC、AV1、VVC）。');
      // SequenceEnd is a control message, not a decoder configuration or
      // coded picture. Legacy muxers may write an AVC terminator for HEVC.
      // Its timestamp must not contribute to video duration or codec selection.
      if (type === 2) {
        if (size !== skip) bad('序列结束标签包含多余的视频数据。');
        offset = next; continue;
      }
      if (codec && codec !== current) bad('不支持文件中途切换视频编码。');
      codec = current;
      if (type === 0) {
        if (size <= skip || size - skip > 1024 * 1024) bad('视频配置头长度无效。');
        const config = await reader.read(start + skip, size - skip);
        const previous = configurations.at(-1);
        if (!previous || previous.length !== config.length || previous.some((v, i) => v !== config[i])) {
          if (configurations.length >= 1024 || configurations.reduce((n, c) => n + c.length, 0) + config.length > 8 * 1024 * 1024) throw new MediaOpenError('resource', 'FLV 视频配置数量或大小超过上限。');
          configurations.push(config.slice()); configuration = configurations.length - 1;
        }
        description ??= config.slice();
      } else if (type === 1 || type === 3) {
        if (!description) bad('视频数据前缺少配置头。');
        if (size <= skip) bad('视频包为空。');
        const dts = (u24(tag, 4) + tag[7] * 16777216) * 1000;
        if (configuration !== (packets.at(-1)?.configuration ?? 0) && frameType !== 1) bad('新视频配置必须从关键帧开始。');
        packets.push({ ...(configuration > 0 ? { configuration } : {}), offset: start + skip, size: size - skip, dts, pts: dts + cts * 1000, key: frameType === 1 });
        if (firstPacket) return { index: buildFlvIndex(codec, description, packets, configurations), nextOffset: next, complete: next === reader.size };
        if (packets.length > 2_000_000) throw new MediaOpenError('resource', 'FLV 帧索引超过安全上限。');
      }
    }
    offset = next;
  }
  if (publicationFailure) throw publicationFailure;
  const { index } = checkpoint(reader.size, true);
  if (truncatedAt !== undefined) index.truncatedAt = truncatedAt;
  return { index, nextOffset: reader.size, complete: true };
  } finally { clearInterval(timer); }
}

export function extendFlvIndex(previous: FlvIndex | undefined, codec: FlvCodec | undefined, description: Uint8Array | undefined, packets: FlvPacket[], configurations?: Uint8Array[]): FlvIndex {
  if (!previous) return buildFlvIndex(codec, description, packets.slice(), configurations?.slice());
  if (packets.length === previous.packets.length && (configurations?.length ?? 1) === (previous.configurations?.length ?? 1)) return previous;
  const added = packets.slice(previous.packets.length).map((_, i) => previous.packets.length + i).sort((a, b) => packets[a].pts - packets[b].pts);
  const order: number[] = [];
  let a = 0, b = 0;
  while (a < previous.order.length || b < added.length) {
    if (b === added.length || (a < previous.order.length && packets[previous.order[a]].pts <= packets[added[b]].pts)) order.push(previous.order[a++]);
    else order.push(added[b++]);
  }
  return finishFlvIndex(codec!, description!, packets.slice(), configurations?.slice(), order);
}

export function buildFlvIndex(codec: FlvCodec | undefined, description: Uint8Array | undefined, packets: FlvPacket[], configurations?: Uint8Array[]): FlvIndex {
  if (!codec || !description || !packets.length || !packets[0].key) bad('没有带配置头和起始关键帧的有效视频。');
  const order = packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts);
  return finishFlvIndex(codec!, description!, packets, configurations, order);
}
function finishFlvIndex(codec: FlvCodec, description: Uint8Array, packets: FlvPacket[], configurations: Uint8Array[] | undefined, order: number[]): FlvIndex {
  const firstPts = packets[order[0]].pts;
  const durations = order.map((p, i) => i + 1 < order.length ? packets[order[i + 1]].pts - packets[p].pts : 0);
  if (durations.slice(0, -1).some(d => d <= 0)) bad('视频包包含重复显示时间戳。');
  durations[durations.length - 1] = durations.length > 1 ? durations[durations.length - 2] : 40000;
  return { ...(configurations && configurations.length > 1 ? { configurations } : {}), codec: codec!, description: description!, packets, order, firstPts, durations, duration: packets[order.at(-1)!].pts - firstPts + durations.at(-1)! };
}

/** A growing FLV index must not move the session clock. The first decode-order
 * key packet establishes time zero; earlier presentation pictures are preroll.
 * Keep every packet (including negative relative PTS) for decoder dependencies.
 * Cache documents contain source timestamps, so old caches use this same rule.
 */
export function flvMediaTiming(index: FlvIndex) {
  const firstPtsUs = index.packets[0].pts;
  return { firstPtsUs, durationUs: index.firstPts + index.duration - firstPtsUs,
    times: index.order.map(i => index.packets[i].pts - firstPtsUs), durations: index.durations };
}

export function flvDecoderConfig(index: Pick<FlvIndex, 'codec' | 'description'>): VideoDecoderConfig | null {
  const b = index.description;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  if (index.codec === 'vvc') return null;
  if (index.codec === 'h264') {
    if (b.length < 7 || b[0] !== 1) bad('AVC 配置头无效。');
    return { codec: `avc1.${[...b.subarray(1, 4)].map(hex).join('')}`, description: b as Uint8Array<ArrayBuffer> };
  }
  if (index.codec === 'av1') {
    if (b.length < 4 || b[0] !== 0x81) bad('AV1 配置头无效。');
    const depth = b[2] & 0x40 ? (b[2] & 0x20 ? 12 : 10) : 8;
    return { codec: `av01.${b[1] >> 5}.${String(b[1] & 31).padStart(2, '0')}${b[2] & 128 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}` };
  }
  if (b.length < 23 || b[0] !== 1) bad('HEVC 配置头无效。');
  let flags = u32(b, 2), reversed = 0;
  for (let i = 0; i < 32; i++) { reversed = (reversed * 2 + (flags & 1)) >>> 0; flags >>>= 1; }
  const constraints = [...b.subarray(6, 12)];
  while (constraints.at(-1) === 0) constraints.pop();
  const geometry = hevcGeometry(b);
  return { ...(geometry ? { codedWidth: geometry.codedWidth, codedHeight: geometry.codedHeight, displayAspectWidth: geometry.width * geometry.sarNum, displayAspectHeight: geometry.height * geometry.sarDen } : {}), codec: `hvc1.${['', 'A', 'B', 'C'][b[1] >> 6]}${b[1] & 31}.${reversed.toString(16)}.${b[1] & 32 ? 'H' : 'L'}${b[12]}${constraints.length ? '.' + constraints.map(hex).join('.') : ''}`, description: b as Uint8Array<ArrayBuffer> };
}

export function flvIndexWarning(index: FlvIndex): string | undefined {
  return index.truncatedAt === undefined ? undefined : '文件尾部不完整，已忽略残缺标签，仅播放完整视频包。';
}
