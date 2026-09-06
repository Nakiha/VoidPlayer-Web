import { MediaOpenError } from './media-errors.ts';

export type FlvInput = { file: Blob } | { url: string; size: number };
export type FlvCodec = 'h264' | 'hevc' | 'av1' | 'vvc';
export interface FlvPacket { offset: number; size: number; pts: number; dts: number; key: boolean; }
export interface FlvIndex {
  codec: FlvCodec;
  description: Uint8Array;
  packets: FlvPacket[]; // decode order; payloads stay in the source
  order: number[]; // presentation order
  firstPts: number;
  duration: number;
  durations: number[];
}
const bad = (message: string): never => { throw new MediaOpenError('container', `FLV：${message}`); };
const u24 = (b: Uint8Array, i: number) => b[i] * 65536 + b[i + 1] * 256 + b[i + 2];
const u32 = (b: Uint8Array, i: number) => b[i] * 16777216 + u24(b, i + 1);
const s24 = (b: Uint8Array, i: number) => (u24(b, i) << 8) >> 8;

/** One bounded read window. Range responses are checked before consuming a body;
 * a server ignoring Range must never silently trigger a full-file download. */
export class FlvReader {
  readonly input: FlvInput;
  size: number;
  private cache: Uint8Array = new Uint8Array(0);
  private start = 0;
  private controller = new AbortController();
  constructor(input: FlvInput) { this.input = input; this.size = 'file' in input ? input.file.size : input.size; }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.controller.signal.aborted) throw new MediaOpenError('input', 'FLV 文件已关闭。');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) bad('文件被截断或标签长度越界。');
    if (!length) return new Uint8Array(0);
    if (offset >= this.start && offset + length <= this.start + this.cache.length) return this.cache.subarray(offset - this.start, offset - this.start + length);
    const end = Math.min(this.size, offset + Math.max(length, 64 * 1024));
    let bytes: Uint8Array;
    try {
      if ('file' in this.input) bytes = new Uint8Array(await this.input.file.slice(offset, end).arrayBuffer());
      else {
        const response = await fetch(this.input.url, { headers: { Range: `bytes=${offset}-${end - 1}` }, signal: this.controller.signal });
        const range = response.headers.get('content-range');
        if (response.status !== 206 || range !== `bytes ${offset}-${end - 1}/${this.size}`) {
          await response.body?.cancel();
          throw new MediaOpenError('input', 'FLV 文件服务必须提供正确的 HTTP Range 响应。');
        }
        bytes = new Uint8Array(await response.arrayBuffer());
      }
    } catch (error) {
      if (error instanceof MediaOpenError) throw error;
      throw new MediaOpenError('input', `读取 FLV 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length !== end - offset) bad('读取长度与文件声明不一致。');
    this.start = offset; this.cache = bytes;
    return bytes.subarray(0, length);
  }
  close() { this.controller.abort(); this.cache = new Uint8Array(0); }
}

/** Standard AVC, legacy CDN HEVC/AV1/VVC and single-track Enhanced FLV.
 * Audio/script tags are skipped: this review app currently has video only. */
export async function demuxFlv(reader: FlvReader): Promise<FlvIndex> {
  const header = await reader.read(0, 9);
  if (header[0] !== 70 || header[1] !== 76 || header[2] !== 86 || header[3] !== 1) bad('不是有效的 FLV 1 文件。');
  let offset = u32(header, 5);
  if (offset < 9 || offset + 4 > reader.size) bad('文件头长度无效。');
  if (u32(await reader.read(offset, 4), 0) !== 0) bad('首个 PreviousTagSize 无效。');
  offset += 4;
  let codec: FlvCodec | undefined;
  let description: Uint8Array | undefined;
  const packets: FlvPacket[] = [];
  while (offset < reader.size) {
    const tag = await reader.read(offset, 11);
    const size = u24(tag, 1), start = offset + 11, next = start + size + 4;
    if (next > reader.size || u24(tag, 8) !== 0) bad('标签长度或 stream ID 无效。');
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
      if (codec && codec !== current) bad('不支持文件中途切换视频编码。');
      codec = current;
      if (type === 0) {
        if (size <= skip || size - skip > 1024 * 1024) bad('视频配置头长度无效。');
        const config = await reader.read(start + skip, size - skip);
        if (description && (description.length !== config.length || description.some((v, i) => v !== config[i]))) bad('不支持文件中途更换视频配置。');
        description = config.slice();
      } else if (type === 1 || type === 3) {
        if (!description) bad('视频数据前缺少配置头。');
        if (size <= skip) bad('视频包为空。');
        const dts = (u24(tag, 4) + tag[7] * 16777216) * 1000;
        packets.push({ offset: start + skip, size: size - skip, dts, pts: dts + cts * 1000, key: frameType === 1 });
        if (packets.length > 2_000_000) throw new MediaOpenError('resource', 'FLV 帧索引超过安全上限。');
      }
    }
    offset = next;
  }
  if (!codec || !description || !packets.length || !packets[0].key) bad('没有带配置头和起始关键帧的有效视频。');
  const order = packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts);
  const firstPts = packets[order[0]].pts;
  const durations = order.map((p, i) => i + 1 < order.length ? packets[order[i + 1]].pts - packets[p].pts : 0);
  if (durations.slice(0, -1).some(d => d <= 0)) bad('视频包包含重复显示时间戳。');
  durations[durations.length - 1] = durations.length > 1 ? durations[durations.length - 2] : 40000;
  return { codec: codec!, description: description!, packets, order, firstPts, durations, duration: packets[order.at(-1)!].pts - firstPts + durations.at(-1)! };
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
  return { codec: `hvc1.${['', 'A', 'B', 'C'][b[1] >> 6]}${b[1] & 31}.${reversed.toString(16)}.${b[1] & 32 ? 'H' : 'L'}${b[12]}${constraints.length ? '.' + constraints.map(hex).join('.') : ''}`, description: b as Uint8Array<ArrayBuffer> };
}
