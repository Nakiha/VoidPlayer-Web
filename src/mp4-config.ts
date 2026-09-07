import { MediaOpenError } from './media-errors.ts';
import type { RangeReader } from './range-reader.ts';

interface Box { type: string; data: number; end: number; }
const invalid = (message: string): never => { throw new MediaOpenError('container', `MP4：${message}`); };
async function boxes(reader: RangeReader, start: number, end: number): Promise<Box[]> {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) invalid('box 头被截断。');
    const header = await reader.read(start, Math.min(16, end - start));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let length = view.getUint32(0), bytes = 8;
    if (length === 1) { if (header.length < 16) invalid('扩展 box 头被截断。'); length = Number(view.getBigUint64(8)); bytes = 16; }
    if (!length) length = end - start;
    if (!Number.isSafeInteger(length) || length < bytes || start + length > end) invalid('box 长度越界。');
    result.push({ type: String.fromCharCode(...header.subarray(4, 8)), data: start + bytes, end: start + length });
    if (result.length > 100000) throw new MediaOpenError('resource', 'MP4 box 数量超过上限。');
    start += length;
  }
  return result;
}

/** Only extracts the unsupported VVC configuration record. Sample tables, edits,
 * B-frame order and seeking stay with mediabunny's public packet API. */
export async function readVvcConfig(reader: RangeReader, trackId: number): Promise<Uint8Array> {
  const moov = (await boxes(reader, 0, reader.size)).find(b => b.type === 'moov');
  if (!moov) return invalid('缺少 moov。');
  for (const track of (await boxes(reader, moov.data, moov.end)).filter(b => b.type === 'trak')) {
    const children = await boxes(reader, track.data, track.end);
    const tkhd = children.find(b => b.type === 'tkhd');
    if (!tkhd) continue;
    const header = await reader.read(tkhd.data, Math.min(24, tkhd.end - tkhd.data));
    const idOffset = header[0] === 1 ? 20 : 12;
    if (header.length < idOffset + 4) return invalid('tkhd 被截断。');
    if (new DataView(header.buffer, header.byteOffset, header.length).getUint32(idOffset) !== trackId) continue;
    let nested = children;
    for (const type of ['mdia', 'minf', 'stbl']) {
      const box = nested.find(b => b.type === type);
      if (!box) return invalid(`缺少 ${type}。`);
      nested = await boxes(reader, box.data, box.end);
    }
    const stsd = nested.find(b => b.type === 'stsd');
    if (!stsd || stsd.end - stsd.data < 8) return invalid('缺少 stsd。');
    const fields = await reader.read(stsd.data, 8);
    if (new DataView(fields.buffer).getUint32(4) !== 1) return invalid('暂不支持多个视频 sample description。');
    const entries = await boxes(reader, stsd.data + 8, stsd.end);
    const sample = entries[0];
    if (!sample || !['vvc1', 'vvi1'].includes(sample.type) || sample.end - sample.data < 78) return invalid('VVC sample entry 无效。');
    const config = (await boxes(reader, sample.data + 78, sample.end)).find(b => b.type === 'vvcC');
    // vvcC is a FullBox: FFmpeg's extradata starts after version/flags.
    if (!config || config.end - config.data <= 4 || config.end - config.data > 1024 * 1024) return invalid('vvcC 配置无效。');
    return reader.read(config.data + 4, config.end - config.data - 4);
  }
  return invalid('未找到对应的 VVC 视频轨道。');
}
