import {TsContainerPacketSource} from '../mpeg2-ts-packet-source.ts';
import { TsPacketSource, tsPictureStream, parseTsPacketIndex, retainVerifiedTsIndex, TsSourceChangedError } from '../ts-packet-source.ts';
import {MatroskaPacketSource} from '../matroska-packet-source.ts';
import {parseJsPacketIndex,loadLocalJsIndex,saveLocalJsIndex} from '../js-packet-index-cache.ts';
import {isSealedJsIndex} from '../js-index-proof.ts';
import {jsPictureStream} from '../matroska-packet-index.ts';
import { inspectPacketPicture } from '../packet-picture.ts';
import { pictureId, BUDGET } from './contract.ts';
import type { SourcePictureKey } from './contract.ts';
import type { AnalysisReader, AnalysisInput, AnalysisPacket } from './types.ts';
import { AnalysisFailure } from './failure.ts';

/** Independent packet source; shared semantics never borrow a playback cursor. */
export async function openJsPacketAnalysisInput(format:'ts'|'matroska',reader: AnalysisReader, sourceVersion: string, signal: AbortSignal, cached?: unknown): Promise<AnalysisInput> {
  let bytesRead=0,operationBytes=0,payloadPhase=false;const observed={size:reader.size,async read(at:number,n:number){
    if(payloadPhase&&operationBytes+n>64*1024*1024)throw new AnalysisFailure('resource-limit','JS analysis advancement IO budget exceeded');
    const bytes=await reader.read(at,n);bytesRead+=bytes.length;if(payloadPhase)operationBytes+=bytes.length;return bytes;
  },close:()=>reader.close()};
  const source=format==='ts'?new TsContainerPacketSource(observed,sourceVersion,signal):new MatroskaPacketSource(observed,sourceVersion,signal);
  try {
    signal.throwIfAborted();
    const restored=parseJsPacketIndex(cached,sourceVersion,reader.size);
    let reusable=restored?.kind==='js-ts-packets'?retainVerifiedTsIndex(restored):restored&&isSealedJsIndex(restored)?restored:undefined;
    if(!reusable&&reader.jsIndex){const delivered=await reader.jsIndex();if(isSealedJsIndex(delivered)&&parseJsPacketIndex(delivered,sourceVersion,reader.size))reusable=delivered;}
    reusable??=await loadLocalJsIndex(observed,sourceVersion,format,signal);
    const index = reusable ?? await source.open();
    signal.throwIfAborted();
    if(!reusable)await saveLocalJsIndex(index,signal);
    payloadPhase=true;
    if(index.codec!=='h264'&&index.codec!=='hevc')throw new AnalysisFailure('unsupported-codec',`Block/QP analysis does not support ${index.codec}; JS packet/index statistics remain available`);
    const codec=index.codec;
    let opened = !reusable;
    let opening: Promise<void> | undefined;
    const configuration = Uint8Array.from(index.configuration);
    const packets: AnalysisPacket[] = index.packets.map(packet => ({ au: packet.au, configuration: packet.configuration,
      pts: packet.ptsUs, dts: packet.timing.dts === null ? null : Math.round(packet.timing.dts * 1e6 / 90000),
      // Opaque locator, readUnit below never performs a byte-range read at it.
      offset: packet.locator, size: packet.size, key: packet.key, timing: packet.timing }));
    const picture = (packet: AnalysisPacket, version: string): SourcePictureKey => {
      if (version !== sourceVersion) throw new AnalysisFailure('source-changed', 'JS packet source version mismatch');
      return { sourceVersion: version, stream: jsPictureStream(index), configuration: 0, au: packet.au, picture: 0, layer: 0, field: 'frame' };
    };
    const readUnit = async (packet: AnalysisPacket) => {
      if (!opened) await (opening ??= source.open(index).then(() => {
        if (!source.indexReused) {source.close();throw new AnalysisFailure('source-changed', 'Cached JS packet index no longer matches source');}
        opened = true;
      }).catch(error=>{source.close();if(error instanceof TsSourceChangedError)throw new AnalysisFailure('source-changed',error.message);throw error;}));
      return source.readUnit(packet.au);
    };
    return { rawTiming: true, codec, configurations: [configuration], packets, sealedEnd: packets.length,
      indexComplete: true,indexIntegrity:index.indexIntegrity??'complete',indexTruncatedAt:index.indexTruncatedAt, totalPackets: packets.length,
      sourceEndUs: index.packets.reduce((end,p)=>Math.max(end,p.ptsUs+p.durationUs),0), reader,
      acknowledge(){operationBytes=0;},read: (offset, length) => observed.read(offset,length), readUnit, picture,
      get bytesRead() { return bytesRead; }, close() { source.close(); },
      async plan(target) {
        if (target.sourceVersion !== sourceVersion) throw new AnalysisFailure('source-changed', 'JS packet source version mismatch');
        const packet = packets.find(p => p.pts === target.sourcePtsUs);
        if (!packet || packet.timing?.pts == null || target.picture && pictureId(target.picture) !== pictureId(picture(packet, sourceVersion)))
          throw new AnalysisFailure('ambiguous-picture-identity', 'JS packet target mismatch');
        for (let start = packet.au; start >= 0 && packet.au - start < BUDGET.packets; start--) {
          if (!packets[start].key) continue;
          const evidence = inspectPacketPicture(index.codec, configuration, await readUnit(packets[start]));
          if (evidence.singlePicture && evidence.closedRandomAccess) return { start, target: packet, identity: picture(packet, sourceVersion) };
        }
        throw new AnalysisFailure('no-safe-anchor-within-budget', 'No verified JS TS IDR within preroll budget');
      },
    };
  } catch (error) { source.close(); throw error; }
}

export const openJsTsAnalysisInput=(reader:AnalysisReader,version:string,signal:AbortSignal,cached?:unknown)=>openJsPacketAnalysisInput('ts',reader,version,signal,cached);
