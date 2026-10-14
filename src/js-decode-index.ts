import {tsDecodeIndex} from './ts-packet-source.ts';
import type {JsPacketIndex} from './matroska-packet-index.ts';
import type {PacketDecodeIndex} from './flv-decoder.ts';
import {isSealedJsIndex} from './js-index-proof.ts';
import {MediaOpenError} from './media-errors.ts';
export function jsDecodeIndex(index:JsPacketIndex):PacketDecodeIndex {
  if(index.kind==='js-ts-packets')return tsDecodeIndex(index);
  if(!isSealedJsIndex(index))throw new MediaOpenError('container','Unverified complete Matroska index');
  const packets=index.packets.map(p=>({sequenceNumber:p.au,configuration:p.configuration,offset:p.locator,size:p.size,pts:p.ptsUs,dts:null,key:p.key,identityKnown:true}));
  const order=packets.map((_,au)=>au).sort((a,b)=>packets[a].pts-packets[b].pts),firstPts=packets[order[0]].pts;
  const durations=order.map((au,i)=>i+1<order.length?packets[order[i+1]].pts-packets[au].pts:index.packets[au].durationUs);
  return {codec:index.codec,description:Uint8Array.from(index.configuration),configurations:[Uint8Array.from(index.configuration)],packets,order,firstPts,duration:packets[order.at(-1)!].pts-firstPts+durations.at(-1)!,durations};
}
