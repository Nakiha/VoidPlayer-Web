import { avcGeometry } from './avc-geometry.ts';
import { MediaOpenError } from './media-errors.ts';
import type { RangeReader } from './range-reader.ts';

interface Box { start: number; type: string; data: number; end: number; truncated?: boolean; declaredEnd?: number; ignoredTail?: boolean; }
const invalid = (message: string): never => { throw new MediaOpenError('container', `MP4：${message}`); };
async function boxes(reader: RangeReader, start: number, end: number, root = false): Promise<Box[]> {
  const result: Box[] = [];
  let fragmented = false;
  const ignoreTail = (type?: string) => {
    if (!root || !result.some(b => b.type === 'moov') || !result.some(b => b.type === 'mdat')
      || (type && ['moov', 'moof', 'mdat', 'mfra', 'sidx', 'ftyp', 'styp'].includes(type))) return false;
    result.push({ start, type: 'ignored-tail', data: start, end, ignoredTail: true });
    return true;
  };
  while (start < end) {
    if (end - start < 8) { if (ignoreTail()) break; invalid('box 头被截断。'); }
    const header = await (fragmented && reader.readMetadata ? reader.readMetadata(start, Math.min(16, end - start)) : reader.read(start, Math.min(16, end - start)));
    if (header.length < 8) return invalid('box 头被截断。');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let length = view.getUint32(0), bytes = 8;
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (length === 1) { if (header.length < 16) { if (ignoreTail(type)) break; invalid('扩展 box 头被截断。'); } length = Number(view.getBigUint64(8)); bytes = 16; }
    if (!length) length = end - start;
    if (!Number.isSafeInteger(length) || length < bytes) { if (ignoreTail(type)) break; invalid('box 长度越界。'); }
    const truncated = length > end - start;
    if (truncated && !(root && type === 'mdat')) { if (ignoreTail(type)) break; invalid(`${type} box 长度越界。`); }
    const declaredEnd = start + length;
    if (!Number.isSafeInteger(declaredEnd)) invalid('box 末尾超出安全整数范围。');
    if (truncated) length = end - start;
    result.push({ start, type, data: start + bytes, end: start + length, ...(truncated ? { truncated: true, declaredEnd } : {}) });
    if (result.length > 100000) throw new MediaOpenError('resource', 'MP4 box 数量超过上限。');
    if (root && type === 'moof') fragmented = true;
    start += length;
  }
  return result;
}

/** Only extracts the unsupported VVC configuration record. Sample tables, edits,
 * B-frame order and seeking stay with mediabunny's public packet API. */
export async function readVvcConfig(reader: RangeReader, trackId: number): Promise<Uint8Array> {
  const moov = (await boxes(reader, 0, reader.size, true)).find(b => b.type === 'moov');
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

export interface Mp4Configurations { warning?: string; indexIntegrity?: import('./index-integrity.ts').IndexIntegrity; indexTruncatedAt?: number; availableSamples?: number; descriptions: Uint8Array[]; sampleConfigurations?: number[]; compositionOffsets?:number[]; decodeTimes?:number[]; sampleOffsets?:number[]; sampleSizes?:number[]; fragmentSequenceNumbers?: number[]; sampleDurations?: number[]; sampleKeys?: boolean[]; }
/** Keep stsd entries and stsc's per-chunk description selection together. The
 * public packet API remains responsible for edit lists and timestamps; these
 * tables own validated byte offsets and the available decode-order prefix. */
export async function readMp4Configurations(reader: RangeReader, trackId: number, maxSamples = 2_000_000, rawTiming = false): Promise<Mp4Configurations> {
  const root=await boxes(reader,0,reader.size,true),moov=root.find(b=>b.type==='moov');
  if(!moov)return invalid('缺少 moov。');
  if(root.some(b=>b.type==='moof') && root.filter(b=>b.type==='moov'||b.type==='moof').reduce((n,b)=>n+b.end-b.start,0)>24*1024*1024)throw new MediaOpenError('resource','MP4 fragment metadata 超过上限。');
  if(root.some(b=>b.type==='moof') && reader.readMetadata)reader={size:reader.size,read:reader.readMetadata.bind(reader)} as RangeReader;
  for(const track of (await boxes(reader,moov.data,moov.end)).filter(b=>b.type==='trak')){
    let nested=await boxes(reader,track.data,track.end);
    const tkhd=nested.find(b=>b.type==='tkhd');if(!tkhd)continue;
    const h=await reader.read(tkhd.data,Math.min(24,tkhd.end-tkhd.data));const off=h[0]===1?20:12;
    if(h.length<off+4)return invalid('tkhd 被截断。');
    if(new DataView(h.buffer,h.byteOffset,h.byteLength).getUint32(off)!==trackId)continue;
    for(const type of ['mdia','minf','stbl']){const b=nested.find(b=>b.type===type);if(!b)return invalid(`缺少 ${type}。`);nested=await boxes(reader,b.data,b.end);}
    const stsd=nested.find(b=>b.type==='stsd');if(!stsd||stsd.end-stsd.data<8)return invalid('缺少 stsd。');
    const entries=await boxes(reader,stsd.data+8,stsd.end);
    const head=await reader.read(stsd.data,8);if(entries.length!==new DataView(head.buffer,head.byteOffset).getUint32(4)||!entries.length||entries.length>256)return invalid('stsd 项数量无效。');
    const descriptions=[];let kind:string|undefined;
    for(const entry of entries){
      const codec=({avc1:'avcC',avc3:'avcC',hvc1:'hvcC',hev1:'hvcC',av01:'av1C',vvc1:'vvcC',vvi1:'vvcC'} as Record<string,string>)[entry.type];
      if(!codec||entry.end-entry.data<78)return invalid('视频 sample description 需要容器解码路径。');
      if(kind&&kind!==codec)return invalid('sample description 跨编码切换需要容器解码路径。');kind=codec;
      const entryBoxes=await boxes(reader,entry.data+78,entry.end);
      if(root.some(b=>b.type==='moof') && entryBoxes.some(b=>b.type==='sinf'))return invalid('加密分片 MP4 暂不支持。');
      const config=entryBoxes.find(b=>b.type===codec);
      const skip=codec==='vvcC'?4:0;
      if(!config||config.end-config.data<=skip||config.end-config.data>1024*1024)return invalid('sample description 配置无效。');
      const description=await reader.read(config.data+skip,config.end-config.data-skip);
      if(codec==='avcC'){const g=avcGeometry(description),header=await reader.read(entry.data,28),v=new DataView(header.buffer,header.byteOffset);if(entries.length===1&&g&&(g.width!==v.getUint16(24)||g.height!==v.getUint16(26)))return invalid('AVC 像素裁剪与 sample entry 不同，需要容器解码路径。');}
      descriptions.push(description);
    }
    if(root.some(b=>b.type==='moof'))return readFragmentConfigurations(reader, root, moov, nested, trackId, descriptions, maxSamples, rawTiming);
    const stsc=nested.find(b=>b.type==='stsc'),stsz=nested.find(b=>b.type==='stsz'),offsets=nested.find(b=>b.type==='stco'||b.type==='co64');
    if(!stsc||!stsz||!offsets||stsc.end-stsc.data<8||stsz.end-stsz.data<12||offsets.end-offsets.data<8)return invalid('多配置样本表不完整。');
    if(stsc.end-stsc.data>24*1024*1024)throw new MediaOpenError('resource','MP4 配置映射超过上限。');
    const data=await reader.read(stsc.data,stsc.end-stsc.data),v=new DataView(data.buffer,data.byteOffset,data.byteLength),count=v.getUint32(4);
    if(8+count*12!==data.length||!count)return invalid('stsc 数量无效。');
    const oz=await reader.read(offsets.data,8),sz=await reader.read(stsz.data,12);
    const chunks=new DataView(oz.buffer,oz.byteOffset).getUint32(4),samples=new DataView(sz.buffer,sz.byteOffset).getUint32(8);
    if(samples>maxSamples||chunks>maxSamples)throw new MediaOpenError('resource','MP4 配置映射超过上限。');
    const sampleConfigurations:number[]=[];
    for(let i=0;i<count;i++){
      const first=v.getUint32(8+i*12),perChunk=v.getUint32(12+i*12),id=v.getUint32(16+i*12)-1;
      const next=i+1<count?v.getUint32(20+i*12):chunks+1;
      if((i===0&&first!==1)||next<=first||next>chunks+1||!perChunk||id<0||id>=descriptions.length||sampleConfigurations.length+(next-first)*perChunk>samples)return invalid('stsc 配置映射越界。');
      for(let n=(next-first)*perChunk;n>0;n--)sampleConfigurations.push(id);
    }
    if(sampleConfigurations.length!==samples)return invalid('stsc 样本总数不一致。');
    if(stsz.end-stsz.data>12+samples*4||offsets.end-offsets.data>8+chunks*8)return invalid('sample 表长度越界。');
    const sizes=await reader.read(stsz.data,stsz.end-stsz.data),sv=new DataView(sizes.buffer,sizes.byteOffset,sizes.byteLength),fixed=sv.getUint32(4);
    if(!fixed&&sizes.length!==12+samples*4)return invalid('stsz 数量无效。');
    const sampleSizes=Array.from({length:samples},(_,i)=>fixed||sv.getUint32(12+i*4));
    const offsetsData=await reader.read(offsets.data,offsets.end-offsets.data),ov=new DataView(offsetsData.buffer,offsetsData.byteOffset,offsetsData.byteLength),stride=offsets.type==='co64'?8:4;
    if(offsetsData.length!==8+chunks*stride)return invalid('chunk offset 数量无效。');
    const sampleOffsets:number[]=[];let run=0;
    const recovered = root.some(b => b.truncated);
    const ignoredTail = root.find(b => b.ignoredTail);
    const damaged = (message: string): never => { throw new MediaOpenError('input', `MP4 文件不完整，无法安全恢复：${message}`); };
    for(let chunk=1;chunk<=chunks;chunk++){
      while(run+1<count&&v.getUint32(20+run*12)<=chunk)run++;
      let offset=stride===8?Number(ov.getBigUint64(8+(chunk-1)*8)):ov.getUint32(8+(chunk-1)*4);
      for(let n=v.getUint32(12+run*12);n>0;n--){
        const size=sampleSizes[sampleOffsets.length];
        if(!Number.isSafeInteger(offset)||!size||offset<0||!Number.isSafeInteger(offset+size)) {
          if(recovered) damaged('样本偏移或长度无效。');
          return invalid('sample offset 越界。');
        }
        if(!recovered&&offset+size>reader.size)return invalid('sample offset 越界。');
        sampleOffsets.push(offset);offset+=size;
      }
    }
    let availableSamples = samples;
    if (recovered || ignoredTail) {
      const media = root.filter(b => b.type === 'mdat');
      let previousEnd = -1;
      for (let i = 0; i < sampleOffsets.length; i++) {
        const offset = sampleOffsets[i], end = offset + sampleSizes[i]; let lo = 0, hi = media.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (media[mid].data <= offset) lo = mid + 1; else hi = mid; }
        const box = media[lo - 1];
        if (!box || end > (box.declaredEnd ?? box.end)) damaged('样本不在声明的 mdat 范围内。');
        // Recovery requires a physical decode-order prefix, never holes or
        // arbitrary out-of-range offsets disguised as a truncated recording.
        if (offset < previousEnd) damaged('样本偏移回退或重叠。');
        previousEnd = end;
        if (end > box.end && availableSamples === samples) availableSamples = i;
        if (i >= availableSamples && end <= box.end) damaged('缺失样本之后又出现有效样本。');
      }
      if (!availableSamples) damaged('没有完整的视频样本。');
    }
    const compositionOffsets=Array<number>(samples).fill(0),ctts=nested.find(b=>b.type==='ctts');
    if(ctts){
      if(ctts.end-ctts.data>24*1024*1024)throw new MediaOpenError('resource','MP4 CTTS 超过上限。');
      const data=await reader.read(ctts.data,ctts.end-ctts.data),cv=new DataView(data.buffer,data.byteOffset,data.byteLength);
      if(data.length<8||data[0]>1||8+cv.getUint32(4)*8!==data.length)return invalid('CTTS 数量无效。');
      let at=0;for(let i=0;i<cv.getUint32(4);i++){const n=cv.getUint32(8+i*8),offset=data[0]===1?cv.getInt32(12+i*8):cv.getUint32(12+i*8);if(at+n>samples)return invalid('CTTS 样本数量越界。');compositionOffsets.fill(offset,at,at+n);at+=n;}
      if(at!==samples)return invalid('CTTS 样本数量不一致。');
    }
    // Preserve source media ticks separately from edit-list/POC presentation
    // time. Older synthetic inputs without STTS report unknown raw timing.
    const stts = nested.find(b => b.type === 'stts');
    let decodeTimes: number[] | undefined;
    if (rawTiming && stts) {
      if (stts.end - stts.data > 24 * 1024 * 1024) throw new MediaOpenError('resource', 'MP4 STTS 超过上限。');
      const data = await reader.read(stts.data, stts.end - stts.data), tv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data.length < 8 || data[0] !== 0 || 8 + tv.getUint32(4) * 8 !== data.length) return invalid('STTS 数量无效。');
      decodeTimes = []; let ticks = 0;
      for (let i = 0; i < tv.getUint32(4); i++) {
        const count = tv.getUint32(8 + i * 8), delta = tv.getUint32(12 + i * 8);
        if (!count || decodeTimes.length + count > samples) return invalid('STTS 样本数量越界。');
        for (let n = 0; n < count; n++) { decodeTimes.push(ticks); ticks += delta; }
        if (!Number.isSafeInteger(ticks)) return invalid('STTS 时间溢出。');
      }
      if (decodeTimes.length !== samples) return invalid('STTS 样本数量不一致。');
    }
    const indexIntegrity = availableSamples < samples ? 'prefix' : recovered || ignoredTail ? 'recovered' : 'complete';
    return {descriptions,sampleConfigurations,compositionOffsets,decodeTimes,sampleOffsets,sampleSizes,availableSamples,indexIntegrity,
      ...(indexIntegrity === 'prefix' ? { indexTruncatedAt: sampleOffsets[availableSamples] } : {}),
      ...(ignoredTail ? {warning: '文件末尾存在异常数据；已验证并保留完整的视频样本。'} : recovered ? {warning: availableSamples < samples
      ? `文件尾部缺失：仅播放前 ${availableSamples} 个完整视频包（声明 ${samples} 个）；时长按有效前缀计算。`
      : 'mdat 声明超出文件末尾；已确认视频样本完整，按实际文件范围读取。'} : {})};
  }
  return invalid('未找到对应的视频轨道。');
}

/** Finite, self-contained fragments only. This maps bytes/raw ticks; Mediabunny
 * owns edit-list-adjusted packet timestamps. No codec payload inspection here. */
async function readFragmentConfigurations(reader: RangeReader, root: Box[], moov: Box, stbl: Box[], trackId: number,
  descriptions: Uint8Array[], maxSamples: number, rawTiming: boolean): Promise<Mp4Configurations> {
  const safe = (n: number, label: string) => { if (!Number.isSafeInteger(n) || n < 0) invalid(`${label} 超出安全整数范围。`); return n; };
  if (root.some(b => b.type === 'pssh')) return invalid('加密分片 MP4 暂不支持。');
  if (root.some(b => b.truncated || b.ignoredTail)) return invalid('分片 MP4 必须完整，不能恢复截断前缀。');
  if (descriptions.length !== 1) return invalid('分片 MP4 仅支持单一 sample description。');
  if (root.filter(b => b.type === 'moov').length !== 1 || root.find(b => b.type === 'moof')!.start < moov.end)
    return invalid('分片 MP4 需要自包含且前置的 init。');
  const metadata = [moov, ...root.filter(b => b.type === 'moof')].reduce((n, b) => n + b.end - b.start, 0);
  if (metadata > 24 * 1024 * 1024) throw new MediaOpenError('resource', 'MP4 fragment metadata 超过上限。');
  const fields = async (b: Box) => { const d = await reader.read(b.data, b.end - b.data); if (d.length !== b.end - b.data) invalid(`${b.type} 被截断。`); return new DataView(d.buffer, d.byteOffset, d.byteLength); };
  const full = (v: DataView, length: number, version = 0) => { if (v.byteLength < length || v.getUint8(0) !== version) invalid('fragment FullBox 无效。'); };
  const single = (list: Box[], type: string) => { const found = list.filter(b => b.type === type); if (found.length !== 1) invalid(`fragment 需要唯一 ${type}。`); return found[0]; };
  const sz = stbl.find(b => b.type === 'stsz');
  if (!sz) return invalid('分片 MP4 缺少空 stsz。');
  const sizes = await fields(sz); full(sizes, 12);
  if (sizes.byteLength !== 12 || sizes.getUint32(8) !== 0 || stbl.some(b => b.type === 'stz2')) return invalid('暂不支持普通 samples 与 fragments 混合。');
  const children = await boxes(reader, moov.data, moov.end);
  let videoTracks = 0;
  for (const track of children.filter(b => b.type === 'trak')) {
    const tc = await boxes(reader, track.data, track.end), mdia = tc.find(b => b.type === 'mdia');
    if (!mdia) continue;
    const mc = await boxes(reader, mdia.data, mdia.end), handler = mc.find(b => b.type === 'hdlr');
    if (!handler || handler.end - handler.data < 12) return invalid('分片 MP4 track handler 无效。');
    const h = await reader.read(handler.data + 8, 4);
    if (String.fromCharCode(...h) === 'vide') videoTracks++;
  }
  if (videoTracks !== 1) return invalid('分片 MP4 需要唯一视频轨道。');
  const mvex = single(children, 'mvex'), defaults = await boxes(reader, mvex.data, mvex.end);
  let trex: DataView | undefined;
  for (const b of defaults.filter(b => b.type === 'trex')) {
    const v = await fields(b); full(v, 24);
    if (v.byteLength !== 24 || v.getUint32(0) !== 0) return invalid('trex 长度或 flags 无效。');
    if (v.getUint32(4) === trackId) { if (trex) return invalid('trex track 重复。'); trex = v; }
  }
  if (!trex) return invalid('分片 MP4 缺少视频 trex。');
  const sampleOffsets: number[] = [], sampleSizes: number[] = [], compositionOffsets: number[] = [],
    sampleDurations: number[] = [], sampleKeys: boolean[] = [], fragmentSequenceNumbers: number[] = [],
    decodeTimes: number[] | undefined = rawTiming ? [] : undefined;
  const media = root.filter(b => b.type === 'mdat');
  let nextDecodeTime: number | undefined;
  for (const moof of root.filter(b => b.type === 'moof')) {
    let foundTrack = false, fragmentIndex = 0;
    const moofBoxes = await boxes(reader, moof.data, moof.end), mfhd = await fields(single(moofBoxes, 'mfhd'));
    full(mfhd, 8); if (mfhd.byteLength !== 8 || mfhd.getUint32(0)) return invalid('mfhd 无效。');
    for (const traf of moofBoxes.filter(b => b.type === 'traf')) {
      const entries = await boxes(reader, traf.data, traf.end), tfhd = await fields(single(entries, 'tfhd'));
      full(tfhd, 8);
      if (tfhd.getUint32(4) !== trackId) continue; // Audio traf does not define a video base or ordinal.
      if (foundTrack) return invalid('同一 moof 存在多个视频 traf。'); foundTrack = true;
      if (entries.some(b => ['senc', 'saiz', 'saio', 'sgpd', 'sbgp'].includes(b.type))) return invalid('分片 MP4 加密/样本分组暂不支持。');
      const flags = tfhd.getUint32(0) & 0xffffff;
      if (flags & ~0x02003b || flags & 0x010000 || (!(flags & 1) && !(flags & 0x020000))) return invalid('tfhd 隐式跨 traf 基址或 flags 暂不支持。');
      let at = 8;
      const u32 = () => { if (at + 4 > tfhd.byteLength) return invalid('tfhd 被截断。'); const n = tfhd.getUint32(at); at += 4; return n; };
      let base = moof.start;
      if (flags & 1) { if (at + 8 > tfhd.byteLength) return invalid('tfhd base 被截断。'); base = safe(Number(tfhd.getBigUint64(at)), 'tfhd base'); at += 8; }
      const description = flags & 2 ? u32() : trex.getUint32(8);
      const duration = flags & 8 ? u32() : trex.getUint32(12), size = flags & 16 ? u32() : trex.getUint32(16), sampleFlags = flags & 32 ? u32() : trex.getUint32(20);
      if (at !== tfhd.byteLength || description !== 1) return invalid('tfhd 长度或 description index 无效。');
      const tfdt = await fields(single(entries, 'tfdt')); if (tfdt.byteLength < 8) return invalid('tfdt 被截断。'); const version = tfdt.getUint8(0);
      if (![0, 1].includes(version) || tfdt.byteLength !== (version === 1 ? 12 : 8) || (tfdt.getUint32(0) & 0xffffff)) return invalid('tfdt 长度或版本无效。');
      let ticks = safe(version === 1 ? Number(tfdt.getBigUint64(4)) : tfdt.getUint32(4), 'tfdt');
      if (nextDecodeTime !== undefined && ticks !== nextDecodeTime) return invalid('分片 MP4 decode 时间断裂或回退。');
      let offset = base;
      const runs = entries.filter(b => b.type === 'trun'); if (!runs.length) return invalid('视频 traf 缺少 trun。');
      for (const run of runs) {
        const v = await fields(run); if (v.byteLength < 8) return invalid('trun 被截断。');
        const version = v.getUint8(0), flags = v.getUint32(0) & 0xffffff, count = v.getUint32(4);
        if (version > 1 || flags & ~0xf05 || (flags & 4 && flags & 0x400)) return invalid('trun flags 或版本无效。');
        if (sampleSizes.length + count > maxSamples) throw new MediaOpenError('resource', 'MP4 fragment sample 数量超过上限。');
        const stride = [0x100, 0x200, 0x400, 0x800].filter(f => flags & f).length * 4;
        if (v.byteLength !== 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + count * stride) return invalid('trun 数量或长度无效。');
        let at = 8;
        if (flags & 1) { offset = safe(base + v.getInt32(at), 'trun data offset'); at += 4; }
        let firstFlags: number | undefined; if (flags & 4) { firstFlags = v.getUint32(at); at += 4; }
        const value = (flag: number, fallback: number) => { if (!(flags & flag)) return fallback; const n = v.getUint32(at); at += 4; return n; };
        for (let i = 0; i < count; i++) {
          const d = value(0x100, duration), s = value(0x200, size), f = value(0x400, i === 0 && firstFlags !== undefined ? firstFlags : sampleFlags);
          let cto = 0; if (flags & 0x800) { cto = version === 1 ? v.getInt32(at) : v.getUint32(at); at += 4; }
          if (!d || !s) return invalid('fragment sample duration/size 必须非零。');
          const end = safe(offset + s, 'fragment sample end');
          let lo = 0, hi = media.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (media[mid].data <= offset) lo = mid + 1; else hi = mid; }
          if (!media[lo - 1] || end > media[lo - 1].end) return invalid('fragment sample 超出 mdat 范围。');
          if (!Number.isSafeInteger(ticks + cto)) return invalid('fragment composition time 溢出。');
          sampleOffsets.push(offset); sampleSizes.push(s); compositionOffsets.push(cto); decodeTimes?.push(ticks);
          sampleDurations.push(d); sampleKeys.push(!(f & 0x10000)); fragmentSequenceNumbers.push(safe(moof.start + fragmentIndex++, 'fragment packet sequence'));
          ticks = safe(ticks + d, 'fragment decode time'); offset = end;
        }
      }
      nextDecodeTime = ticks;
    }
  }
  if (!sampleSizes.length) return invalid('分片 MP4 没有完整视频 sample。');
  const order = sampleOffsets.map((_, i) => i).sort((a, b) => sampleOffsets[a] - sampleOffsets[b]);
  for (let i = 1; i < order.length; i++) if (sampleOffsets[order[i]] < sampleOffsets[order[i - 1]] + sampleSizes[order[i - 1]]) return invalid('fragment sample 重叠。');
  return { descriptions, sampleConfigurations: Array(sampleSizes.length).fill(0), sampleOffsets, sampleSizes, compositionOffsets,
    decodeTimes, sampleDurations, sampleKeys, fragmentSequenceNumbers, availableSamples: sampleSizes.length, indexIntegrity: 'complete' };
}

/** Verify the pinned demuxer's fragment locator before assigning our continuous
 * decode-order AU. A fragment sequence number is never an analysis identity. */
export function validateFragmentPacket(config: Mp4Configurations, au: number, packet: { sequenceNumber: number; byteLength: number; type: string; timestamp: number }, resolution: number) {
  if (!config.fragmentSequenceNumbers) return;
  if (packet.sequenceNumber !== config.fragmentSequenceNumbers[au] || packet.byteLength !== config.sampleSizes![au]
    || (packet.type === 'key') !== config.sampleKeys![au]
    || !Number.isSafeInteger(Math.round(packet.timestamp * 1e6))
    || !Number.isSafeInteger(Math.round(packet.timestamp * 1e6 - config.compositionOffsets![au] / resolution * 1e6)))
    invalid('fragment packet 与 sample mapping 不一致。');
}
