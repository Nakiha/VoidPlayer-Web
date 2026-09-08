import { avcGeometry } from './avc-geometry.ts';
import { MediaOpenError } from './media-errors.ts';
import type { RangeReader } from './range-reader.ts';

interface Box { type: string; data: number; end: number; truncated?: boolean; }
const invalid = (message: string): never => { throw new MediaOpenError('container', `MP4：${message}`); };
async function boxes(reader: RangeReader, start: number, end: number, root = false): Promise<Box[]> {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) invalid('box 头被截断。');
    const header = await reader.read(start, Math.min(16, end - start));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let length = view.getUint32(0), bytes = 8;
    if (length === 1) { if (header.length < 16) invalid('扩展 box 头被截断。'); length = Number(view.getBigUint64(8)); bytes = 16; }
    if (!length) length = end - start;
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (!Number.isSafeInteger(length) || length < bytes) invalid('box 长度越界。');
    const truncated = length > end - start;
    if (truncated && !(root && type === 'mdat')) invalid(`${type} box 长度越界。`);
    if (truncated) length = end - start;
    result.push({ type, data: start + bytes, end: start + length, ...(truncated ? { truncated: true } : {}) });
    if (result.length > 100000) throw new MediaOpenError('resource', 'MP4 box 数量超过上限。');
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

export interface Mp4Configurations { warning?: string; descriptions: Uint8Array[]; sampleConfigurations?: number[]; compositionOffsets?:number[]; sampleOffsets?:number[]; sampleSizes?:number[]; }
/** Keep stsd entries and stsc's per-chunk description selection together. The
 * public packet API remains responsible for edits, sample offsets and timestamps. */
export async function readMp4Configurations(reader: RangeReader, trackId: number): Promise<Mp4Configurations> {
  const root=await boxes(reader,0,reader.size,true),moov=root.find(b=>b.type==='moov');
  if(!moov)return invalid('缺少 moov。');
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
      const config=(await boxes(reader,entry.data+78,entry.end)).find(b=>b.type===codec);
      const skip=codec==='vvcC'?4:0;
      if(!config||config.end-config.data<=skip||config.end-config.data>1024*1024)return invalid('sample description 配置无效。');
      const description=await reader.read(config.data+skip,config.end-config.data-skip);
      if(codec==='avcC'){const g=avcGeometry(description),header=await reader.read(entry.data,28),v=new DataView(header.buffer,header.byteOffset);if(entries.length===1&&g&&(g.width!==v.getUint16(24)||g.height!==v.getUint16(26)))return invalid('AVC 像素裁剪与 sample entry 不同，需要容器解码路径。');}
      descriptions.push(description);
    }
    // Fragmented multi-description movies require tfhd/trex selection; reject
    // at the container boundary until it can be represented without guessing.
    if(root.some(b=>b.type==='moof'))return invalid('分片 MP4 的 DTS/配置映射需要容器解码路径。');
    const stsc=nested.find(b=>b.type==='stsc'),stsz=nested.find(b=>b.type==='stsz'),offsets=nested.find(b=>b.type==='stco'||b.type==='co64');
    if(!stsc||!stsz||!offsets||stsc.end-stsc.data<8||stsz.end-stsz.data<12||offsets.end-offsets.data<8)return invalid('多配置样本表不完整。');
    if(stsc.end-stsc.data>24*1024*1024)throw new MediaOpenError('resource','MP4 配置映射超过上限。');
    const data=await reader.read(stsc.data,stsc.end-stsc.data),v=new DataView(data.buffer,data.byteOffset,data.byteLength),count=v.getUint32(4);
    if(8+count*12!==data.length||!count)return invalid('stsc 数量无效。');
    const oz=await reader.read(offsets.data,8),sz=await reader.read(stsz.data,12);
    const chunks=new DataView(oz.buffer,oz.byteOffset).getUint32(4),samples=new DataView(sz.buffer,sz.byteOffset).getUint32(8);
    if(samples>2_000_000||chunks>2_000_000)throw new MediaOpenError('resource','MP4 配置映射超过上限。');
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
    for(let chunk=1;chunk<=chunks;chunk++){
      while(run+1<count&&v.getUint32(20+run*12)<=chunk)run++;
      let offset=stride===8?Number(ov.getBigUint64(8+(chunk-1)*8)):ov.getUint32(8+(chunk-1)*4);
      for(let n=v.getUint32(12+run*12);n>0;n--){const size=sampleSizes[sampleOffsets.length];if(!Number.isSafeInteger(offset)||!size||offset<0||offset+size>reader.size)return invalid('sample offset 越界。');sampleOffsets.push(offset);offset+=size;}
    }
    const recovered = root.some(b => b.truncated);
    if (recovered) {
      const media = root.filter(b => b.type === 'mdat');
      for (let i = 0; i < sampleOffsets.length; i++) {
        const offset = sampleOffsets[i]; let lo = 0, hi = media.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (media[mid].data <= offset) lo = mid + 1; else hi = mid; }
        if (!lo || sampleSizes[i] > media[lo - 1].end - offset) return invalid('mdat 不完整：视频样本缺失或不在媒体数据范围内。');
      }
    }
    const compositionOffsets=Array<number>(samples).fill(0),ctts=nested.find(b=>b.type==='ctts');
    if(ctts){
      if(ctts.end-ctts.data>24*1024*1024)throw new MediaOpenError('resource','MP4 CTTS 超过上限。');
      const data=await reader.read(ctts.data,ctts.end-ctts.data),cv=new DataView(data.buffer,data.byteOffset,data.byteLength);
      if(data.length<8||data[0]>1||8+cv.getUint32(4)*8!==data.length)return invalid('CTTS 数量无效。');
      let at=0;for(let i=0;i<cv.getUint32(4);i++){const n=cv.getUint32(8+i*8),offset=data[0]===1?cv.getInt32(12+i*8):cv.getUint32(12+i*8);if(at+n>samples)return invalid('CTTS 样本数量越界。');compositionOffsets.fill(offset,at,at+n);at+=n;}
      if(at!==samples)return invalid('CTTS 样本数量不一致。');
    }
    return {descriptions,sampleConfigurations,compositionOffsets,sampleOffsets,sampleSizes,...(recovered ? {warning:'mdat 声明超出文件末尾；已确认视频样本完整，按实际文件范围读取。'} : {})};
  }
  return invalid('未找到对应的视频轨道。');
}
