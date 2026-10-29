import type {RationalClock} from '../../media/indexing/rational-clock.ts';
import {parseFlvIndex} from '../../media/indexing/flv-index-cache.ts';
import type {FlvIndexDocument} from '../../media/indexing/flv-index-cache.ts';
import {parseMp4QualityDocument} from '../../media/indexing/mp4-quality-index.ts';
import type {Mp4QualityDocument} from '../../media/indexing/mp4-quality-index.ts';
import type {FlvPacket,FlvRecoveredGap,FlvTruncationReason} from '../../media/containers/flv-demux.ts';

export type QualityIndexDocument=FlvIndexDocument|Mp4QualityDocument;
/** Container-neutral decode-order packet view; never serialized as a FLV cache. */
export type QualityVideoIndex={codec:'h264'|'hevc'|'av1'|'vvc';description:Uint8Array;packets:FlvPacket[];order:number[];firstPts:number;duration:number;durations:number[];
  configurations?:Uint8Array[];truncatedAt?:number;truncationReason?:FlvTruncationReason;recoveredGaps?:FlvRecoveredGap[];container?:'flv'|'mp4';mp4?:Mp4QualityDocument};
export const isMp4QualityDocument=(d:QualityIndexDocument):d is Mp4QualityDocument=>d.schema==='voidplayer-mp4-quality-index';
export const qualityIndexPacketCount=(d:QualityIndexDocument)=>isMp4QualityDocument(d)?d.samples.length:d.packets.length;
export function qualitySourceIndex(d:QualityIndexDocument,size:number):QualityVideoIndex{
  if(!isMp4QualityDocument(d))return {...parseFlvIndex(d,size),container:'flv'};
  const doc=parseMp4QualityDocument(d,size),packets=doc.samples.map(s=>({offset:s.offset,size:s.size,pts:s.ptsUs,dts:s.dtsUs,key:s.key,configuration:0})),order=packets.map((_,i)=>i).sort((a,b)=>packets[a].pts-packets[b].pts),firstPts=packets[order[0]].pts;
  const end=doc.samples.reduce((n,s)=>Math.max(n,s.ptsUs+s.durationUs),firstPts);
  return {container:'mp4',mp4:doc,codec:doc.codec,description:new Uint8Array(doc.description),packets,order,firstPts,duration:end-firstPts,durations:order.map(i=>doc.samples[i].durationUs)};
}

export function qualitySourceClock(index:QualityVideoIndex,au:number):RationalClock {
  const sample=index.mp4?.samples[au];
  if(sample)return {ticks:sample.dtsTicks+sample.ctsTicks,timescale:index.mp4!.timescale};
  const packet=index.packets[au];if(!packet)throw Error('Missing source AU clock');
  return {ticks:packet.pts,timescale:1000000};
}
