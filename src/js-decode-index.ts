import {tsDecodeIndex} from '../shared/media/containers/ts-packet-source.ts';
import type {JsPacketIndex} from '../shared/media/containers/matroska-packet-index.ts';
import type { PacketDecodeIndex } from '../shared/media/indexing/packet-decode-index.ts';
import {isSealedJsIndex} from '../shared/media/indexing/js-index-proof.ts';
import {MediaOpenError} from '../shared/media/io/media-errors.ts';
export function jsDecodeIndex(index:JsPacketIndex):PacketDecodeIndex {
  if(index.kind==='js-ts-packets')return tsDecodeIndex(index);
  if(!isSealedJsIndex(index))throw new MediaOpenError('container','Unverified complete Matroska index');
  const packets=index.packets.map(p=>({sequenceNumber:p.au,configuration:p.configuration,offset:p.locator,size:p.size,pts:p.ptsUs,dts:null,key:p.key,identityKnown:true}));
  const order=packets.map((_,au)=>au).sort((a,b)=>packets[a].pts-packets[b].pts),firstPts=packets[order[0]].pts;
  const durations=order.map((au,i)=>i+1<order.length?packets[order[i+1]].pts-packets[au].pts:index.packets[au].durationUs);
  return {codec:index.codec,codecParameters:index.codecParameters,description:Uint8Array.from(index.configuration),configurations:[Uint8Array.from(index.configuration)],packets,order,firstPts,duration:packets[order.at(-1)!].pts-firstPts+durations.at(-1)!,durations};
}
