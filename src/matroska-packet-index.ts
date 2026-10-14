import type {TsPacketIndex,TsPacketRecord} from './ts-packet-index.ts';
export const MATROSKA_PACKET_BUILD='mediabunny-1.55.7-matroska-packets-v2';
export interface MatroskaPacketRecord extends Omit<TsPacketRecord,'timing'|'pesOffset'> {
  blockOffset:number;
  timing:{pts:number;dts:null;timebase:[number,number];origin:'matroska-block'};
}
export interface MatroskaPacketIndex extends Omit<TsPacketIndex,'schema'|'kind'|'build'|'packets'|'codec'> {
  schema:1;kind:'js-matroska-packets';build:typeof MATROSKA_PACKET_BUILD;
  codec:'h264'|'hevc'|'vp8'|'vp9';packets:MatroskaPacketRecord[];
}
export type JsPacketIndex=TsPacketIndex|MatroskaPacketIndex;
export const jsPictureStream=(index:JsPacketIndex)=>`${index.streamKey}:${index.pid}@${index.build}`;
export function parseMatroskaPacketIndex(value:unknown,version:string,size:number):MatroskaPacketIndex|undefined {
  if(!value||typeof value!=='object')return;const d=value as Partial<MatroskaPacketIndex>;
  if(d.schema!==1||d.kind!=='js-matroska-packets'||d.build!==MATROSKA_PACKET_BUILD||d.sourceVersion!==version||d.size!==size||d.streamKey!=='video:0'
    ||!Number.isSafeInteger(d.pid)||d.pid!<1||!['h264','hevc','vp8','vp9'].includes(d.codec??'')
    ||!Array.isArray(d.configuration)||d.configuration.length>4096||!d.configuration.every(b=>Number.isInteger(b)&&b>=0&&b<256)
    ||!Array.isArray(d.packets)||!d.packets.length||d.packets.length>250000||d.completeness?.state!=='complete'||d.completeness.packets!==d.packets.length)return;
  if((d.codec==='h264'||d.codec==='hevc')&&!d.configuration.length)return;
  const times=new Set<number>();
  for(let au=0;au<d.packets.length;au++){const p=d.packets[au];
    if(!p||p.au!==au||p.configuration!==0||!Number.isSafeInteger(p.locator)||p.locator<0||p.locator>=size||au>0&&p.locator<=d.packets[au-1].locator
      ||!Number.isSafeInteger(p.blockOffset)||p.blockOffset<0||p.blockOffset>=size||!Number.isSafeInteger(p.ptsUs)||!Number.isFinite(p.timestamp)||Math.round(p.timestamp*1e6)!==p.ptsUs
      ||!Number.isSafeInteger(p.durationUs)||p.durationUs<0||!Number.isSafeInteger(p.size)||p.size<=0||p.size>32*1024*1024||typeof p.key!=='boolean'||times.has(p.ptsUs)
      ||!p.timing||p.timing.origin!=='matroska-block'||p.timing.dts!==null||!Number.isSafeInteger(p.timing.pts)
      ||!Number.isSafeInteger(p.timing.timebase?.[0])||p.timing.timebase[0]<1||p.timing.timebase[0]>1e9||p.timing.timebase[1]!==1e9
      ||!Number.isSafeInteger(p.timing.pts*p.timing.timebase[0])||Math.round(p.timing.pts*p.timing.timebase[0]/1000)!==p.ptsUs)return;
    times.add(p.ptsUs);
  }
  return d as MatroskaPacketIndex;
}
