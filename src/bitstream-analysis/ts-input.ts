import { parseFfmpegIndex, ffmpegTicksToUs, FFMPEG_NO_TIMESTAMP } from '../ffmpeg-index-cache.ts';
import { isAnnexB, nalRanges } from '../nal-framing.ts';
import { parseAvcSps } from '../avc-geometry.ts';
import { inspectPacketPicture } from '../packet-picture.ts';
import { BUDGET, pictureId } from './contract.ts';
import type { AnalysisTarget, SourcePictureKey } from './contract.ts';
import type { AnalysisReader, AnalysisPacket, AnalysisInput, AnalysisInputOptions } from './types.ts';
import { AnalysisFailure } from './failure.ts';

/** Finite, single-video, static progressive H264 TS. Independent fmt/AVIO owns
 * parser reassembly; index positions are locators, never raw payload ranges. */
export async function openTsAnalysisInput(reader: AnalysisReader, signal: AbortSignal, continuous = false, options?: AnalysisInputOptions): Promise<AnalysisInput> {
  let core: any, ctx = 0, closed = false, bytesRead = 0, operationBytes = 0, lastAu = -1;
  let ioFailure: unknown;
  const close = () => {
    if (closed) return; closed = true;
    if (ctx) core._vpd_close(ctx);
    if (core) core.vpDemuxRead = undefined;
    reader.close();
  };
  function fail(reason: string): never { throw new AnalysisFailure('ambiguous-picture-identity', reason); }
  const string = (ptr: number) => {
    const end = core.HEAPU8.indexOf(0, ptr);
    if (ptr <= 0 || end < ptr || end-ptr > 256) throw new Error('Invalid demux string');
    return new TextDecoder().decode(core.HEAPU8.subarray(ptr, end));
  };
  try {
    signal.throwIfAborted();
    if (!options?.demuxCore || !reader.readSync || !reader.ffmpegIndex)
      throw new AnalysisFailure('unsupported-container', 'TS analysis requires independent synchronous IO and a complete source-bound packet index');
    const snapshot = await reader.ffmpegIndex(); signal.throwIfAborted();
    const parsed = parseFfmpegIndex(snapshot, reader.size);
    if (!parsed || parsed.document.count > 250000 || parsed.document.indexIntegrity === 'prefix')
      fail('TS index identity or completeness mismatch');
    const doc = parsed.document;
    if(doc.codec!=='h264' || !doc.analysisConfiguration)throw new AnalysisFailure('unsupported-picture-layout','TS requires a complete static in-band parameter-set snapshot');
    const configuration=Uint8Array.from(atob(doc.analysisConfiguration.data),c=>c.charCodeAt(0));
    if(!isAnnexB(configuration))fail('Missing TS Annex-B parameter sets');
    const ensureDemux=async () => {
      if(ctx)return;
      core = typeof options.demuxCore === 'function' ? await options.demuxCore() : options.demuxCore;
      signal.throwIfAborted();
      if (typeof core._vpd_abi !== 'function' || core._vpd_abi() !== 1 ||
          string(core._vpd_compat_id()) !== 'ffmpeg-9.0.2-avformat-740392267b71-ts-raw-input-v2' ||
          string(core._vpd_build_id()) !== doc.indexerBuild)
        throw new AnalysisFailure('internal-error', 'Demux ABI/implementation/indexer identity mismatch');
      operationBytes=0;core.vpDemuxError=undefined;
      core.vpDemuxRead = (_handle: number, offset: number, length: number) => {
        try {signal.throwIfAborted();
        if (closed || !Number.isSafeInteger(offset) || offset<0 || length<0 || length>256*1024 || offset+length>reader.size)
          throw new AnalysisFailure('resource-limit', 'Demux IO bounds exceeded');
        if ((continuous ? operationBytes : bytesRead)+length>64*1024*1024) throw new AnalysisFailure('resource-limit', 'TS request/advancement IO budget exceeded');
        const bytes = reader.readSync!(offset, length);bytesRead+=bytes.length;operationBytes+=bytes.length;return bytes;
        }catch(error){ioFailure=error;return -1;}
      };
      ctx=core._vpd_open(-1, BigInt(reader.size));
      if(ioFailure || core.vpDemuxError)throw ioFailure ?? core.vpDemuxError;
      if (!ctx || string(core._vpd_format(ctx)) !== 'mpegts' || string(core._vpd_codec(ctx)) !== 'h264' || core._vpd_video_count(ctx)!==1)
        throw new AnalysisFailure('unsupported-container', 'Only finite single-video H264 TS is admitted');
      if (core._vpd_stream(ctx)!==doc.streamIndex || core._vpd_tb_num(ctx)!==doc.timeBaseNum || core._vpd_tb_den(ctx)!==doc.timeBaseDen)
        fail('Independent TS demux stream/timebase mismatch');
      const p=core._malloc(parsed.records.length);if(!p)throw new AnalysisFailure('resource-limit','Demux index allocation failed');
      try {core.HEAPU8.set(parsed.records,p);if(core._vpd_bind_index(ctx,p,doc.count)!==0)fail('Demux source ordinal table rejected');}
      finally {core._free(p);}
    };
    const sets=new Map<number, Uint8Array>();
    const checkSets=(bytes: Uint8Array) => {
      for (const n of nalRanges('h264', configuration, bytes)) {
        const type=bytes[n.offset]&31;
        if (type!==7 && type!==8) continue;
        const nal=bytes.slice(n.offset,n.offset+n.size), previous=sets.get(type);
        if (previous && (previous.length!==nal.length || previous.some((b,i)=>b!==nal[i])))
          throw new AnalysisFailure('unsupported-picture-layout', 'Dynamic TS parameter sets are not admitted');
        if (type===7 && parseAvcSps(nal).interlaced) throw new AnalysisFailure('unsupported-picture-layout', 'Interlaced TS is not admitted');
        sets.set(type,nal);
      }
    };
    checkSets(configuration);
    if (!sets.has(7) || !sets.has(8)) fail('Missing static SPS/PPS');
    const v=new DataView(parsed.records.buffer,parsed.records.byteOffset,parsed.records.byteLength);
    const packets: AnalysisPacket[]=new Array(doc.count), raw: {pts: bigint; dts: bigint; duration: bigint; pos: bigint; size: number}[]=new Array(doc.count);
    const byPts=new Map<number,AnalysisPacket>();
    for (let i=0;i<doc.count;i++) {
      const at=i*48, au=Number(v.getBigUint64(at+40,true));
      const pts=v.getBigInt64(at,true), dts=v.getBigInt64(at+8,true), duration=v.getBigInt64(at+16,true), pos=v.getBigInt64(at+24,true), size=v.getInt32(at+32,true);
      if(au>=doc.count || packets[au] || pts===FFMPEG_NO_TIMESTAMP || dts===FFMPEG_NO_TIMESTAMP || duration<0n || size<1 || size>BUDGET.packetBytes)fail('Missing/ambiguous TS timing or AU');
      const packet={au,configuration:0,pts:ffmpegTicksToUs(pts,doc.timeBaseNum,doc.timeBaseDen),dts:ffmpegTicksToUs(dts,doc.timeBaseNum,doc.timeBaseDen),offset:Number(pos),size,key:!!(v.getUint32(at+36,true)&1),timing:{pts:Number(pts),dts:Number(dts),timebase:[doc.timeBaseNum,doc.timeBaseDen] as [number,number]}};
      if(byPts.has(packet.pts))fail('Duplicate TS PTS');
      packets[au]=packet;raw[au]={pts,dts,duration,pos,size};byPts.set(packet.pts,packet);
    }
    for(let i=0;i<doc.count;i++) {
      if(!packets[i])fail('Missing TS source ordinal');
      if(i) {const gap=raw[i].dts-raw[i-1].dts, nominal=raw[i-1].duration || (raw[1].dts-raw[0].dts), error=gap-nominal;
        // Mux timebase quantization may vary one tick; retain every raw tick.
        if(gap<=0n || error < -1n || error > 1n)fail('TS decode timing discontinuity');}
    }
    const picture=(packet:AnalysisPacket,version:string):SourcePictureKey=>({sourceVersion:version,stream:`video:${doc.streamIndex}`,configuration:0,au:packet.au,picture:0,layer:0,field:'frame'});
    const readUnit=async (packet:AnalysisPacket) => {
      signal.throwIfAborted();
      await ensureDemux();
      if(lastAu!==packet.au-1) {
        let anchor=packet.au;
        while(anchor>0 && !packets[anchor].key)anchor--;
        if(packet.au-anchor>=BUDGET.packets)throw new AnalysisFailure('no-safe-anchor-within-budget','No TS anchor within budget');
        const seek=core._vpd_seek(ctx,raw[anchor].dts);
        if(ioFailure || core.vpDemuxError)throw ioFailure ?? core.vpDemuxError;
        if(seek<0)fail('TS seek failed');lastAu=-1;
      }
      for(let tries=0;tries<BUDGET.packets;tries++) {
        const status=core._vpd_read(ctx,128);
        if(ioFailure || core.vpDemuxError)throw ioFailure ?? core.vpDemuxError;
        if(status===2)continue;
        if(status!==1)fail('TS demux ended before requested AU');
        try {
          const pointer=core._vpd_packet(ctx), view=new DataView(core.HEAPU8.buffer,pointer,72);
          const au=Number(view.getBigUint64(32,true)),flags=view.getUint32(44,true);
          if((flags&7)!==7 || flags&16 || au>=packets.length || (lastAu>=0 && au!==lastAu+1))fail('TS source ordinal could not be restored');
          const source=raw[au];
          if(view.getBigInt64(0,true)!==source.pts || view.getBigInt64(8,true)!==source.dts || view.getBigInt64(24,true)!==source.pos || view.getInt32(52,true)!==source.size)fail('TS demux tuple mismatch');
          lastAu=au;
          if(au>packet.au)fail('TS seek overshot source AU');
          if(au===packet.au) {
            const ptr=view.getUint32(48,true),size=view.getInt32(52,true);
            if(ptr<1 || size<1 || ptr+size>core.HEAPU8.length)fail('TS payload bounds');
            const bytes=core.HEAPU8.slice(ptr,ptr+size);checkSets(bytes);
            if(!inspectPacketPicture('h264',configuration,bytes).singlePicture)throw new AnalysisFailure('unsupported-picture-layout','TS packet does not prove one progressive picture');
            return bytes;
          }
        } finally { core._vpd_release(ctx); }
      }
      throw new AnalysisFailure('resource-limit','TS demux advancement budget exceeded');
    };
    return {codec:'h264',configurations:[configuration],packets,sealedEnd:packets.length,indexComplete:true,indexIntegrity:'complete',totalPackets:packets.length,
      sourceEndUs:packets.reduce((max,p)=>Math.max(max,p.pts),0)+ffmpegTicksToUs(raw.at(-1)!.duration || (raw[1] ? raw[1].dts-raw[0].dts : 1n),doc.timeBaseNum,doc.timeBaseDen), reader,
      get analysisCore(){return core;},acknowledge(){if(continuous)operationBytes=0;},read:(offset,length)=>reader.read(offset,length),readUnit,picture,get bytesRead(){return bytesRead;},
      async plan(target:AnalysisTarget) {
        const packet=byPts.get(target.sourcePtsUs);if(!packet || (target.picture && pictureId(picture(packet,target.sourceVersion))!==pictureId(target.picture)))fail('TS target picture mismatch');
        for(let start=packet.au;start>=0 && packet.au-start<BUDGET.packets;start--)if(packets[start].key) {
          const evidence=inspectPacketPicture('h264',configuration,await readUnit(packets[start]));
          if(evidence.singlePicture && evidence.closedRandomAccess)return {start,target:packet,identity:picture(packet,target.sourceVersion)};
        }
        throw new AnalysisFailure('no-safe-anchor-within-budget','No syntax-proven TS IDR within preroll budget');
      },close};
  } catch(error){close();throw error;}
}
