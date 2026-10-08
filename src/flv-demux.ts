import { hevcGeometry } from './hevc-geometry.ts';
import { RangeReader } from './range-reader.ts';
import type { RangeVersion } from './range-reader.ts';
import { MediaOpenError } from './media-errors.ts';

export type FlvInput = { file: Blob } | { url: string; size: number };
export interface FlvScanReader { readonly size: number; read(offset: number, length: number): Promise<Uint8Array>; }
export type FlvCodec = 'h264' | 'hevc' | 'av1' | 'vvc';
export interface FlvPacket { sequenceNumber?:number; configuration?: number; discontinuity?: boolean; offset: number; size: number; pts: number; dts: number; key: boolean; originalPts?: number; }
export interface FlvRecoveredGap { offset: number; size: number; resumeAt: number; }
export type FlvTruncationReason = 'incomplete-tag' | 'invalid-tag' | 'recovery-budget' | 'no-random-access';
export interface FlvIndex {
  recoveredGaps?: FlvRecoveredGap[]; // Skipped bytes, with subsequent tags structurally revalidated.
  configurations?: Uint8Array[]; // Configuration records in decode-order segments.
  truncatedAt?: number; // Start of an incomplete or corrupt trailing tag, never a playable packet.
  truncationReason?: FlvTruncationReason;
  codec: FlvCodec;
  description: Uint8Array;
  packets: FlvPacket[]; // decode order; payloads stay in the source
  order: number[]; // All packets in stable presentation order, including equal PTS.
  displayOrder?: number[]; // First packet per unique PTS when timestamps collide.
  firstPts: number; // Earliest indexed presentation PTS, not the media timeline origin.
  duration: number;
  durations: number[];
}
class InvalidVideoTag extends MediaOpenError {
  constructor(message:string){super('container',`FLV：${message}`);}
}
const invalidVideo = (message:string):never => {throw new InvalidVideoTag(message);};
const bad = (message: string): never => { throw new MediaOpenError('container', `FLV：${message}`); };
const u24 = (b: Uint8Array, i: number) => b[i] * 65536 + b[i + 1] * 256 + b[i + 2];
const u32 = (b: Uint8Array, i: number) => b[i] * 16777216 + u24(b, i + 1);
const s24 = (b: Uint8Array, i: number) => (u24(b, i) << 8) >> 8;

// Limits bound recovery work, never invalidate an already validated prefix.
export const FLV_RESYNC_BYTES = 1024 * 1024;
export const FLV_RESYNC_TOTAL_BYTES = 4 * 1024 * 1024;
export const FLV_RESYNC_GAPS = 16;
const RESYNC_BLOCK_BYTES = 64 * 1024;
const RESYNC_CANDIDATES = 256;
interface RecoveryBudget { bytes: number; candidates: number; }
async function resyncFlv(reader: FlvScanReader, offset: number, budget: RecoveryBudget): Promise<{ offset?: number; exhausted: boolean }> {
  const read = async (at: number, length: number) => {
    if (length > budget.bytes) return undefined;
    budget.bytes -= length;
    return reader.read(at, length); // IO/version/cancellation errors propagate.
  };
  const tagEnd=async (at:number):Promise<number|undefined> => {
    if(at+15>reader.size)return;
    const header=await read(at,11);if(!header)return;
    const size=u24(header,1),end=at+15+size;
    if(![8,9,18].includes(header[0])||u24(header,8)!==0||!size||end>reader.size)return;
    const footer=await read(end-4,4);
    if(!footer||u32(footer,0)!==size+11)return;
    return end;
  };
  const limit=Math.min(FLV_RESYNC_BYTES,reader.size-offset-15);
  for(let first=1;first<=limit;first+=RESYNC_BLOCK_BYTES){
    const count=Math.min(RESYNC_BLOCK_BYTES,limit-first+1);
    const bytes=await read(offset+first,count+10);
    if(!bytes)return {exhausted:true};
    for(let i=0;i<count;i++){
      if(![8,9,18].includes(bytes[i])||u24(bytes,i+8)!==0)continue;
      if(budget.candidates--<=0)return {exhausted:true};
      const next=await tagEnd(offset+first+i);
      if(next!==undefined&&await tagEnd(next)!==undefined)return {offset:offset+first+i,exhausted:false};
      if(budget.bytes<15)return {exhausted:true};
    }
    // Yield between blocks so closing a local Blob scan can cancel its next read.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  return {exhausted:reader.size-offset-15>limit};
}

/** Only a closed NAL random-access picture can restart after unknown lost data.
 * Container key flags and AVC recovery points alone do not prove this. AV1
 * recovery stays conservative until we have an equivalent bitstream validator. */
async function recoveryKey(reader:FlvScanReader,codec:FlvCodec,description:Uint8Array,at:number,size:number,budget:RecoveryBudget):Promise<boolean>{
  const lengthBytes=codec==='h264'&&description.length>=7?(description[4]&3)+1
    :codec==='hevc'&&description.length>=23?(description[21]&3)+1
    :codec==='vvc'&&description.length>=1?((description[0]>>1)&3)+1:0;
  if(!lengthBytes)return false;
  let end=at+size,found=false,nals=0;
  while(at<end){
    const headerBytes=lengthBytes+(codec==='h264'?1:2);
    if(++nals>256||at+headerBytes>end||budget.bytes<headerBytes)return false;
    budget.bytes-=headerBytes;
    const header=await reader.read(at,headerBytes);
    let length=0;for(let i=0;i<lengthBytes;i++)length=length*256+header[i];
    if(length<headerBytes-lengthBytes||at+lengthBytes+length>end)return false;
    const first=header[lengthBytes],second=header[lengthBytes+1];
    if(first&0x80)return false;
    const type=codec==='h264'?first&31:codec==='hevc'?(first>>1)&63:(second>>3)&31;
    const closed=codec==='h264'?type===5&&(first&0x60)!==0
      :codec==='hevc'?[19,20].includes(type):[7,8].includes(type);
    if(codec!=='h264'&&(second&7)===0)return false;
    // A packet mixing an IDR with dependent VCL data is not a safe restart.
    if(!closed&&(codec==='h264'?type>=1&&type<=5:codec==='hevc'?type<=31:type<=11))return false;
    found ||= closed;
    at+=lengthBytes+length;
  }
  return found;
}

export function flvIndexIntegrity(index:FlvIndex):'complete'|'recovered'|'prefix'{
  return index.truncatedAt!==undefined?'prefix':index.recoveredGaps?.length?'recovered':'complete';
}

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

export async function demuxFlv(reader: FlvScanReader, onProgress?: () => void): Promise<FlvIndex> {
  return (await scanFlv(reader, onProgress)).index;
}

/** Stop after the first video packet for startup; resume at the next tag. */
export async function scanFlv(reader: FlvScanReader, onProgress?: () => void, resume?: FlvCheckpoint, firstPacket = false, publish?: (checkpoint: FlvCheckpoint) => void): Promise<FlvCheckpoint> {
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
  let truncationReason: FlvTruncationReason | undefined;
  const recoveredGaps = resume?.index.recoveredGaps?.map(g=>({...g})) ?? [];
  const budget:RecoveryBudget={bytes:Math.max(0,FLV_RESYNC_TOTAL_BYTES-recoveredGaps.reduce((n,g)=>n+g.size,0)),candidates:RESYNC_CANDIDATES};
  let recovery: { offset:number; size:number; configurationCount:number; minimumPts:number; searchEnd:number } | undefined;
  let reported = performance.now();
  let published = resume?.index;
  const checkpoint = (nextOffset: number, complete: boolean) => {
    // Sort only newly discovered packets, then merge with the existing order.
    let index: FlvIndex;
    try { index = extendFlvIndex(published, codec, description, packets, configurations); }
    catch (error) {
      if (error instanceof MediaOpenError) throw new MediaOpenError(error.stage,
        `${error.message} scan=${JSON.stringify({ nextOffset, complete, size: reader.size, previousPackets: published?.packets.length ?? 0, packets: packets.length })}`);
      throw error;
    }
    if(recoveredGaps.length)index={...index,recoveredGaps:recoveredGaps.map(g=>({...g}))};
    published = index;
    return { index, nextOffset, complete };
  };
  let publicationFailure: unknown;
  let publishedOffset = resume?.nextOffset ?? offset;
  const publishProgress = () => {
    if (!publish || recovery || !packets.length || offset <= publishedOffset || publicationFailure) return;
    try { publish(checkpoint(offset, false)); publishedOffset = offset; onProgress?.(); }
    catch (error) { publicationFailure = error; }
  };
  const recoverDamage = async (reason:FlvTruncationReason) => {
    const result = !recovery && recoveredGaps.length<FLV_RESYNC_GAPS
      ? await resyncFlv(reader,offset,budget) : {exhausted:true};
    if(result.offset!==undefined){
      recovery={offset,size:result.offset-offset,configurationCount:configurations.length,
        minimumPts:packets.reduce((n,p)=>Math.max(n,p.pts),-Infinity),searchEnd:Math.min(reader.size,result.offset+FLV_RESYNC_BYTES)};
      offset=result.offset;return true;
    }
    truncatedAt=offset;truncationReason=result.exhausted?'recovery-budget':reason;
    return false;
  };
  // Publish the validated prefix even if the next HTTP read is still pending.
  // Never emit heartbeats for unchanged bytes: stalled IO must still time out.
  const timer = publish ? setInterval(publishProgress, 500) : undefined;
  try {
  while (offset < reader.size) {
    if (publicationFailure) throw publicationFailure;
    if(recovery&&offset>=recovery.searchEnd){truncatedAt=recovery.offset;truncationReason='recovery-budget';break;}
    if (performance.now() - reported >= 500) {
      onProgress?.();
      publishProgress();
      if (publicationFailure) throw publicationFailure;
      reported = performance.now();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (reader.size - offset < 11) { truncatedAt = offset; truncationReason='incomplete-tag'; break; }
    const tag = await reader.read(offset, 11);
    const size = u24(tag, 1), start = offset + 11, next = start + size + 4;
    const structuralError = u24(tag,8) !== 0 ? `标签 @${offset} 的 stream ID 无效。`
      : ![8,9,18].includes(tag[0]) ? `标签 @${offset} 的类型或标志无效。`
      : next <= reader.size && u32(await reader.read(next-4,4),0) !== size+11 ? 'PreviousTagSize 与标签长度不一致。' : undefined;
    if (structuralError || next > reader.size) {
      if(!description||!packets.length||!packets[0].key)bad(structuralError??'没有带配置头和起始关键帧的有效视频。');
      if(await recoverDamage(structuralError?'invalid-tag':'incomplete-tag'))continue;
      break;
    }
    try {
    if ((tag[0] & 31) === 9) {
      if (tag[0] & 0xe0) bad('不支持加密或扩展标签标志。');
      if (size < 1) invalidVideo('视频标签为空。');
      const b = await reader.read(start, Math.min(size, 8));
      const flags = b[0], enhanced = !!(flags & 0x80), frameType = (flags >> 4) & 7;
      if (frameType < 1 || frameType > 5) invalidVideo('视频帧类型无效。');
      if (frameType === 5) { offset = next; continue; } // video command, no picture
      let current: FlvCodec | undefined, type: number, skip: number, cts = 0;
      if (enhanced) {
        type = flags & 15;
        if (type === 4) { offset = next; continue; } // metadata, not a coded picture
        if (![0, 1, 2, 3].includes(type)) bad('暂不支持 Enhanced FLV 多轨或扩展包类型。');
        if (size < 5) invalidVideo('Enhanced 视频头被截断。');
        const fourcc = String.fromCharCode(...b.subarray(1, 5));
        current = ({ avc1: 'h264', hvc1: 'hevc', av01: 'av1', vvc1: 'vvc' } as Record<string, FlvCodec>)[fourcc];
        skip = 5;
        // AV1 packets have no composition-time field in Enhanced FLV.
        if (type === 1 && current !== 'av1') { if (size < 8) invalidVideo('缺少 composition time。'); cts = s24(b, 5); skip = 8; }
      } else {
        current = ({ 7: 'h264', 12: 'hevc', 13: 'av1', 14: 'vvc' } as Record<number, FlvCodec>)[flags & 15];
        if (size < 5) invalidVideo('视频头被截断。');
        type = b[1]; skip = 5; cts = s24(b, 2);
        if (![0, 1, 2].includes(type)) invalidVideo('未知视频包类型。');
      }
      if (!current) throw new MediaOpenError('codec', 'FLV 视频编码暂不支持（支持 AVC、HEVC、AV1、VVC）。');
      // SequenceEnd is a control message, not a decoder configuration or
      // coded picture. Legacy muxers may write an AVC terminator for HEVC.
      // Its timestamp must not contribute to video duration or codec selection.
      if (type === 2) {
        if (size !== skip) invalidVideo('序列结束标签包含多余的视频数据。');
        offset = next; continue;
      }
      if (codec && codec !== current) bad('不支持文件中途切换视频编码。');
      codec = current;
      if (type === 0) {
        if (size <= skip || size - skip > 1024 * 1024) bad('视频配置头长度无效。');
        const config = await reader.read(start + skip, size - skip);
        // Keep only the last uncommitted configuration while looking for a
        // closed recovery anchor. Discarded pictures never create segments.
        if(recovery&&configurations.length>recovery.configurationCount)configurations.length=recovery.configurationCount;
        const previous = configurations.at(-1);
        if (!previous || previous.length !== config.length || previous.some((v, i) => v !== config[i])) {
          if (configurations.length >= 1024 || configurations.reduce((n, c) => n + c.length, 0) + config.length > 8 * 1024 * 1024) throw new MediaOpenError('resource', 'FLV 视频配置数量或大小超过上限。');
          configurations.push(config.slice()); configuration = configurations.length - 1;
        }
        configuration=configurations.length-1;
        description ??= config.slice();
      } else if (type === 1 || type === 3) {
        if (!description) bad('视频数据前缺少配置头。');
        if (size <= skip) invalidVideo('视频包为空。');
        const dts = (u24(tag, 4) + tag[7] * 16777216) * 1000;
        const pts=dts+cts*1000;
        if(recovery){
          if(frameType!==1||pts<=recovery.minimumPts||!await recoveryKey(reader,current,configurations[configuration],start+skip,size-skip,budget)){
            offset=next;continue;
          }
          recoveredGaps.push({offset:recovery.offset,size:recovery.size,resumeAt:offset});
          recovery=undefined;
        }
        if (configuration !== (packets.at(-1)?.configuration ?? 0) && frameType !== 1) bad('新视频配置必须从关键帧开始。');
        const discontinuity=recoveredGaps.at(-1)?.resumeAt===offset;
        packets.push({ ...(configuration > 0 ? { configuration } : {}), ...(discontinuity?{discontinuity:true}:{}), offset: start + skip, size: size - skip, dts, pts, key: frameType === 1 });
        if (firstPacket) return { index: buildFlvIndex(codec, description, packets, configurations), nextOffset: next, complete: next === reader.size };
        if (packets.length > 2_000_000) throw new MediaOpenError('resource', 'FLV 帧索引超过安全上限。');
      }
    }
    } catch(error) {
      if(!(error instanceof InvalidVideoTag)||!description||!packets.length||!packets[0].key)throw error;
      if(await recoverDamage('invalid-tag'))continue;
      break;
    }
    offset = next;
  }
  if (publicationFailure) throw publicationFailure;
  if(recovery){
    truncatedAt=recovery.offset;truncationReason??='no-random-access';
    configurations.length=recovery.configurationCount;
  }
  const nextOffset=truncatedAt??reader.size;
  const { index:prefix } = checkpoint(nextOffset, true);
  // A completed degraded result must not mutate an earlier published prefix.
  const index=truncatedAt===undefined?prefix:{...prefix,truncatedAt,truncationReason};
  return { index, nextOffset, complete: true };
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
  const invalid = durations.findIndex((d, i) => i + 1 < durations.length && (d < 0 || order[i] === order[i + 1]));
  if (invalid !== -1) {
    const left = order[invalid], right = order[invalid + 1];
    // Equal timestamps are supported; broken ordering or duplicate references
    // still indicate an invalid index. Preserve evidence across worker RPC.
    const reason = left === right ? '显示索引重复引用同一视频包。' : '显示索引顺序回退。';
    const context = {
      codec, packets: packets.length, orderLength: order.length, displayPosition: invalid, deltaUs: durations[invalid],
      pair: [left, right].map(packetIndex => {
        const p = packets[packetIndex];
        // Compact tuples keep both packets plus scan context below the logger's
        // 800-character string limit: [index, offset, size, PTS, DTS, key, config].
        return [packetIndex, p.offset, p.size, p.pts, p.dts, +p.key, p.configuration ?? 0];
      }),
    };
    bad(`${reason} indexContext=${JSON.stringify(context)}`);
  }
  // Each equal-PTS group owns one display interval. Keep all compressed
  // packets for dependencies; neither payloads nor source timestamps change.
  let interval = durations.findLast(d => d > 0) ?? 40000;
  for (let i = durations.length - 1; i >= 0; i--) {
    if (durations[i] > 0) interval = durations[i];
    else durations[i] = interval;
  }
  const displayOrder = order.filter((p, i) => i === 0 || packets[p].pts !== packets[order[i - 1]].pts);
  return { ...(displayOrder.length < order.length ? { displayOrder } : {}), ...(configurations && configurations.length > 1 ? { configurations } : {}), codec: codec!, description: description!, packets, order, firstPts, durations, duration: packets[order.at(-1)!].pts - firstPts + durations.at(-1)! };
}

/** A growing FLV index must not move the session clock. The first decode-order
 * key packet establishes time zero; earlier presentation pictures are preroll.
 * Keep every packet (including negative relative PTS) for decoder dependencies.
 * Cache documents contain source timestamps, so old caches use this same rule.
 */
export function flvMediaTiming(index: FlvIndex) {
  const firstPtsUs = index.packets[0].pts;
  const times: number[] = [], durations: number[] = [];
  for (let i = 0; i < index.order.length; i++) {
    const pts = index.packets[index.order[i]].pts - firstPtsUs;
    if (i === 0 || pts !== times.at(-1)) { times.push(pts); durations.push(index.durations[i]); }
  }
  return { firstPtsUs, durationUs: index.firstPts + index.duration - firstPtsUs,
    times, durations };
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
  const warnings: string[] = [];
  if(index.recoveredGaps?.length){
    const first=index.recoveredGaps[0],bytes=index.recoveredGaps.reduce((n,g)=>n+g.size,0);
    warnings.push(`文件存在 ${index.recoveredGaps.length} 处损坏间隙，已跳过 ${bytes} 字节并重同步标签；首处偏移=${first.offset}，长度=${first.size}。缺失的视频数据可能影响附近画面。`);
    if(index.recoveredGaps.some(g=>g.resumeAt>g.offset+g.size))warnings.push('恢复点之前的依赖帧已跳过，从可独立解码的画面恢复播放。');
  }
  if (index.truncatedAt !== undefined) {
    const reason=({'incomplete-tag':'标签不完整','invalid-tag':'标签损坏','recovery-budget':'恢复搜索达到上限','no-random-access':'未找到可独立解码的恢复帧'} as const)[index.truncationReason??'incomplete-tag'];
    warnings.push(`文件尾部不完整或损坏，已保留有效视频前缀；偏移 ${index.truncatedAt} 之后的内容未恢复，原因：${reason}。`);
  }
  if (index.displayOrder) {
    const i = index.order.findIndex((p, i) => i > 0 && index.packets[p].pts === index.packets[index.order[i - 1]].pts);
    const a = index.packets[index.order[i - 1]], b = index.packets[index.order[i]];
    warnings.push(`视频包有 ${index.order.length - index.displayOrder.length} 个重复 PTS；保留全部解码包，同一时刻只展示首个输出画面。首处 PTS=${a.pts}，包偏移=${a.offset}/${b.offset}。`);
  }
  return warnings.join(' ') || undefined;
}
