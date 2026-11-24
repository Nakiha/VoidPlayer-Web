import type { loadServerPlaybackCore } from './playback-core.ts';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { CustomSource, EncodedPacketSink, Input, MP4, QTFF, MATROSKA, WEBM, MPEG_TS } from 'mediabunny';
import jpeg from 'jpeg-js';
import { firstAnnexBPicture } from '../shared/media/containers/annex-b-packet-source.ts';
import { readPlaybackContainer } from '../shared/media/containers/container-header.ts';
import { scanFlv } from '../shared/media/containers/flv-demux.ts';
import { matroskaFfv1Configuration, matroskaStructure } from '../shared/media/containers/matroska-clocks.ts';
import type { PacketCodecParameters } from '../shared/media/containers/matroska-clocks.ts';
import { readVvcConfig, readMp4Configurations } from '../shared/media/containers/mp4-config.ts';
import { readTsPesClocks } from '../shared/media/containers/ts-packet-source.ts';
import { staticTsPsi } from '../shared/media/containers/ts-static-psi.ts';
import { readTsPesPayload } from '../shared/media/containers/ts-pes-payload.ts';
import { readWasmFrame } from '../shared/wasm/frame.ts';
import { hdrTransfer } from '../shared/color/hdr-policy.ts';
import { resolveYuvColor } from '../shared/color/yuv-color.ts';
import { thumbnailPixels, thumbnailSize } from '../shared/thumbnails/pixels.ts';
import { THUMB_MAX_BYTES, THUMB_JPEG_QUALITY, THUMB_JPEG_FALLBACK_QUALITY } from '../shared/thumbnails/contract.ts';
import { fileVersion } from './file-stat.ts';

export type CoverInput = {filePath:string; fingerprint:string};
export type CoverImage = {bytes:Uint8Array; width:number; height:number; sourcePtsUs:number};

export async function decodeCover({core,heap}:Awaited<ReturnType<typeof loadServerPlaybackCore>>, input:CoverInput):Promise<CoverImage> {
  const fd = openSync(input.filePath,'r');
  let ctx = 0, media:Input | undefined;
  try {
    const stat = fstatSync(fd), size = stat.size;
    const verify = () => {
      if (!stat.isFile() || fileVersion(fstatSync(fd)) !== input.fingerprint || fileVersion(statSync(input.filePath)) !== input.fingerprint)
        throw new Error('Media changed while generating cover');
    };
    verify();
    let bytesRead = 0;
    const read = (at:number,n:number) => {
      bytesRead += n;
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(n) || at<0 || n<0 || n>size-at || bytesRead>32*1024*1024)
        throw new Error('Cover read budget exceeded');
      const bytes = new Uint8Array(n);
      for (let used=0;used<n;) {
        const count=readSync(fd,bytes,used,n-used,at+used);
        if (!count) throw new Error('Short cover read');
        used+=count;
      }
      return bytes;
    };
    const reader = {size,read:async (at:number,n:number)=>read(at,n),close(){}};
    const format = await readPlaybackContainer(reader);
    core._vp_set_threads(1);
    ctx = core._vp_create();
    if (!ctx) throw new Error('Decoder allocation failed');
    let rotation = 0, ready = false;
    const configure = (codec:string, extra:Uint8Array, parameters?:PacketCodecParameters) => {
      const data = codec==='av1' ? extra.subarray(4) : extra;
      if (data.length>1024*1024) throw new Error('Cover codec configuration too large');
      const ptr = core._malloc(Math.max(1,data.length)+40) >>> 0;
      if (!ptr) throw new Error('Cannot allocate cover configuration');
      try {
        heap().set(data,ptr+40);
        let status;
        if (parameters) {
          const p=parameters, view=new DataView(heap().buffer,ptr,40);
          [1,40,p.width,p.height,p.sarNum,p.sarDen,p.colorPrimaries,p.colorTransfer,p.colorSpace,p.colorRange]
            .forEach((v,i)=>view.setInt32(4*i,v,true));
          status=core.ccall('vp_packet_open_config','number',['number','string','number','number','number'],[ctx,codec,ptr+40,data.length,ptr]);
        } else status=core.ccall('vp_packet_open','number',['number','string','number','number'],[ctx,codec,ptr+40,data.length]);
        if (status!==0) throw new Error('Unsupported cover codec: '+codec);
      } finally {core._free(ptr);}
    };
    let packets=0;
    const submit = (bytes?:Uint8Array, pts=0, dts:number|null=null, key=false) => {
      if (++packets>128) throw new Error('Cover packet budget exceeded');
      if (bytes) {
        const ptr=core._vp_packet_alloc(ctx,bytes.length)>>>0;
        if (!ptr) throw new Error('Cover packet allocation failed');
        heap().set(bytes,ptr);
      }
      if (core._vp_packet_try_send(ctx,BigInt(pts),dts===null?-9223372036854775808n:BigInt(dts),+key,bytes?0:1)!==0)
        throw new Error('Cover packet rejected');
      const status=core._vp_packet_receive(ctx,0n);
      if (status<0) throw new Error('Cover decode failed');
      ready=status===1;
    };
    if (format==='other') {
      core.vpBlobs=new Map([[ctx,{blob:{size,slice:(start:number,end:number)=>({start,end})},
        reader:{readAsArrayBuffer:({start,end}:{start:number;end:number})=>read(start,Math.min(end,size)-start).buffer}}]]);
      ready=core._vp_open_blob(ctx,ctx,BigInt(size))===0 && core._vp_prime_first_presentable(ctx)===1;
    } else if (format === 'annexb') {
      const first = await firstAnnexBPicture(reader);
      configure(first.codec, first.config);
      submit(first.bytes, 0, null, true);
      if (!ready) submit();
    } else if (format==='flv') {
      let part=await scanFlv(reader,undefined,undefined,true);
      configure(part.index.codec,part.index.description);
      while (true) {
        const packet=part.index.packets.at(-1)!;
        submit(read(packet.offset,packet.size),packet.pts,packet.dts,packet.key);
        if (ready || part.complete) break;
        const next=await scanFlv(reader,undefined,part,true);
        if (next.index.packets.length===part.index.packets.length) break;
        part=next;
      }
    } else {
      const psi=format==='mpegts' && read(0,1)[0]===0x47 ? staticTsPsi(read(0,Math.min(size,188*348))) : undefined;
      if (psi?.videoStreams.length===1 && psi.videoStreams[0].type===2) {
        const {pid}=psi.videoStreams[0];
        const clocks=[...await readTsPesClocks(reader,pid,new AbortController().signal,undefined,32)];
        configure('mpeg2video',new Uint8Array());
        const complete=clocks.length===32?31:clocks.length;
        for (let i=0;i<complete && !ready;i++) {
          const [start,clock]=clocks[i], end=clocks[i+1]?.[0]??size;
          if (clock.pts===null) throw new Error('Missing MPEG-2 cover timestamp');
          submit(await readTsPesPayload(reader.read,start,end,pid,psi),Math.round(clock.pts*1e6/90000),
            clock.dts===null?null:Math.round(clock.dts*1e6/90000),i===0);
        }
      } else {
        media=new Input({source:new CustomSource({getSize:()=>size,read:(a,b)=>read(a,b-a),maxCacheSize:1024*1024}),
          formats:format==='isobmff'?[MP4,QTFF]:format==='matroska'?[MATROSKA,WEBM]:[MPEG_TS]});
        const track=await media.getPrimaryVideoTrack();
        if (!track) throw new Error('No video track');
        rotation=track.rotation;
        const rawId=String(await track.getInternalCodecId()), known=await track.getCodec();
        let codec:string|null=known==='avc'?'h264':known, extra:Uint8Array=new Uint8Array(), parameters:PacketCodecParameters|undefined;
        if (format==='matroska') {
          const {configuration}=await matroskaStructure(reader,track.id,new AbortController().signal,true);
          const ffv1=matroskaFfv1Configuration(configuration);
          if (ffv1) codec='ffv1';
          extra=ffv1??configuration.description;
          parameters=configuration.parameters;
        } else if (rawId==='vvc1'||rawId==='vvi1') {
          codec='vvc'; extra=await readVvcConfig(reader,track.id);
        } else if (['mp4v','jpeg','mjpa','mjpb','apch','apcn','apcs','apco','ap4h','ap4x'].includes(rawId)) {
          const config=await readMp4Configurations(reader,track.id);
          codec=rawId==='mp4v'?'mpeg4':rawId.startsWith('ap')?'prores':'mjpeg';
          extra=config.descriptions[0]; parameters=config.codecParameters?.[0];
        } else if (format==='isobmff') {
          const raw=(await track.getDecoderConfig())?.description;
          if (raw) extra=ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength):new Uint8Array(raw);
        }
        if (!codec) throw new Error('Unsupported cover codec');
        configure(codec,extra,parameters);
        for await (const packet of new EncodedPacketSink(track).packets()) {
          submit(packet.data,Math.round(packet.timestamp*1e6),null,packet.type==='key');
          if (ready) break;
        }
      }
    }
    if (!ready && format!=='other') submit();
    if (!ready) throw new Error('No presentable first frame');
    const frame=readWasmFrame(core,heap,ctx), d=frame.description;
    if (d.yuv ? !resolveYuvColor(d).supported : hdrTransfer(d.sourceColor?.transfer)) throw new Error('Unsupported cover color');
    const sourcePtsUs=format==='other' ? Math.round(frame.pts*core._vp_tb_num(ctx)*1e6/core._vp_tb_den(ctx)) : frame.pts;
    const {width,height}=thumbnailSize(d,rotation);
    const data=thumbnailPixels(d,new Uint8Array(frame.pixels),rotation,width,height);
    for (const quality of [THUMB_JPEG_QUALITY,THUMB_JPEG_FALLBACK_QUALITY]) {
      const bytes=jpeg.encode({width,height,data},Math.round(quality*100)).data;
      if (bytes.length<=THUMB_MAX_BYTES) {verify();return {width,height,bytes,sourcePtsUs};}
    }
    throw new Error('Cover exceeds size budget');
  } finally {
    media?.dispose();
    if (ctx) {core.vpBlobs?.delete(ctx);core._vp_destroy(ctx);}
    closeSync(fd);
  }
}
