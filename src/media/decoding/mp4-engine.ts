import type { DecodeThreads } from '../policy/wasm-threads.ts';
import { inspectMp4Playback } from '../../../shared/media/containers/mp4-playback.ts';
import { loadLibraryMp4Playback } from '../indexing/mp4-playback-client.ts';
import type { MediaOpenProgress } from '../progress.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';
import { RangeReader } from '../../../shared/media/io/range-reader.ts';
import { Mp4CachedMetadata } from '../indexing/mp4-cached-metadata.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import { wasmPacketDecoder, nativePacketDecoder } from './flv-decoder.ts';
import type { PacketDecoder, PacketFrame } from './flv-decoder.ts';
import type { PacketDecodeIndex } from '../../../shared/media/indexing/packet-decode-index.ts';
import { PacketTimeline } from './packet-timeline.ts';

/** Packet tables are decode anchors; actual output frames own display time. */
export class Mp4Engine {
  private reader:RangeReader;
  private controller = new AbortController();
  private audioMetadata = new Mp4CachedMetadata();
  private index!:PacketDecodeIndex;
  private timeline?:PacketTimeline;
  private primed:PacketFrame|null=null;
  private nativeConfig?:VideoDecoderConfig;
  private displayBounds:{width:number;height:number}[]=[];
  private rotation: 0 | 90 | 180 | 270 = 0;
  private displayed(frame: PacketFrame): PacketFrame {
    const original=frame.description,bounds=this.displayBounds[frame.packetPicture?.configuration??0];
    let d=original;
    if(bounds&&(bounds.width<d.width||bounds.height<d.height)){const width=Math.min(bounds.width,d.width),height=Math.min(bounds.height,d.height);
      d={...d,width,height,visibleRect:{...d.visibleRect,width,height},displayWidth:Math.max(1,Math.round(width*d.displayWidth/d.width)),displayHeight:Math.max(1,Math.round(height*d.displayHeight/d.height))};
    }
    const swap = this.rotation === 90 || this.rotation === 270;
    return { ...frame,description:d, rotation: this.rotation, width: swap ? d.displayHeight : d.displayWidth, height: swap ? d.displayWidth : d.displayHeight };
  }
  constructor(source:RandomAccessInput){
    this.reader=new RangeReader(source);
  }
  cachedWindows() { return this.reader.cachedWindows(); }
  peekCachedBytes(offset: number, length: number) { return this.reader.peek(offset, length) ?? this.audioMetadata.peek(offset, length); }
  async open(glueURL:string,wasmBinary?:Uint8Array,forceWasm=true,threads:DecodeThreads=1,onProgress?:MediaOpenProgress){
    try{
      onProgress?.('inspect');
      const playback = 'url' in this.reader.input && this.reader.input.library
        ? await loadLibraryMp4Playback(this.reader.input, this.controller.signal, () => onProgress?.('index'))
        : await inspectMp4Playback(this.reader, () => onProgress?.('index'), (at, bytes) => this.audioMetadata.observe(at, bytes));
      this.audioMetadata.retainPrefix(this.reader.peek(0, Math.min(65536, this.reader.size)));
      const { index, rotation, displayBounds, nativeConfig, recovered } = playback;
      this.index = index; this.rotation = rotation; this.displayBounds = displayBounds; this.nativeConfig = nativeConfig;
      const { codec, firstPts, duration, durations } = index;
      const pts = index.order.map(i => index.packets[i].pts);
      onProgress?.('decoder');
      const native=!forceWasm&&this.nativeConfig?await nativePacketDecoder(this.index,this.nativeConfig):null;
      const decoder:PacketDecoder=native||await wasmPacketDecoder(this.index,glueURL,wasmBinary,threads);
      this.timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size),true);
      onProgress?.('first-frame');
      try { this.primed=await this.timeline.at(recovered?firstPts:Math.max(0,firstPts)); }
      catch(error) {
        if(decoder.kind!=='webcodecs'||!(error instanceof MediaOpenError)||error.stage!=='decode')throw error;
        this.timeline.close();this.timeline=undefined;
        const software=await wasmPacketDecoder(this.index,glueURL,wasmBinary,threads);
        this.timeline=new PacketTimeline(this.index,software,packet=>this.reader.read(packet.offset,packet.size),true);
        this.primed=await this.timeline.at(recovered?firstPts:Math.max(0,firstPts));
      }
      const firstPtsUs=this.primed.pts;
      const activeDecoder=this.timeline.decoder;
      const color=activeDecoder.kind==='webcodecs'?playback.color:null;
      return {codec,decoder:activeDecoder.kind,hardwareAcceleration:activeDecoder.hardwareAcceleration,width:this.displayed(this.primed).width,height:this.displayed(this.primed).height,...activeDecoder.metadata?.(),
        ...(color?{colorSource:'container' as const,color:{primaries:color.primaries??null,transfer:color.transfer??null,matrix:color.matrix??null,fullRange:color.fullRange??null}}:{}),
        ...(recovered?{timelineSource:'hevc-poc' as const}:{}),
        indexIntegrity: playback.indexIntegrity, indexTruncatedAt: playback.indexTruncatedAt, indexWarning: playback.indexWarning,
        indexSource: 'url' in this.reader.input && this.reader.input.library ? 'server' as const : 'client' as const,
        firstPtsUs,durationUs:firstPts+duration-firstPtsUs,times:pts.filter(p=>p>=firstPtsUs).map(p=>p-firstPtsUs),durations};
    }catch(error){this.close();throw error;}
  }
  tuneVvc(axis?: import('../contract.ts').VvcTuningAxis) { return this.timeline?.decoder.tuneVvc?.(axis) ?? null; }
  /** 只读分析查询共用：返回 demux 包表，不转移底层缓冲。 */
  get analysisIndex(): PacketDecodeIndex | undefined { return this.index; }
  async at(pts:number,recycle?:ArrayBuffer){
    if(this.primed&&this.primed.pts===pts){const f=this.primed;this.primed=null;return this.displayed(f);}
    this.primed?.frame?.close();this.primed=null;return this.displayed(await this.timeline!.at(pts,recycle));
  }
  async next(pts:number,recycle?:ArrayBuffer){const frame=await this.timeline!.next(pts,recycle);return frame?this.displayed(frame):null;}
  /** Produce a first-frame software witness from this MP4 index and reader. */
  async referenceWitness(glueURL:string,wasmBinary?:Uint8Array,threads:DecodeThreads=1):Promise<PacketFrame>{
    if(this.timeline?.decoder.kind!=='webcodecs'||!this.timeline)throw new MediaOpenError('decode','MP4 原生解码器尚未就绪。');
    const decoder=await wasmPacketDecoder(this.index,glueURL,wasmBinary,threads);
    const timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size),true);
    try{return this.displayed(await timeline.at(this.primed?.pts??this.index.packets[this.index.order[0]].pts));}
    finally{timeline.close();}
  }
  /** Replace the active decoder without rebuilding the MP4 sample table. */
  async switchToSoftware(glueURL:string,wasmBinary?:Uint8Array,threads:DecodeThreads=1){
    if(this.timeline?.decoder.kind==='webcodecs'){
      const decoder=await wasmPacketDecoder(this.index,glueURL,wasmBinary,threads);
      const timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size),true);
      const target=this.primed?.pts??this.index.packets[this.index.order[0]].pts;
      let primed:PacketFrame;
      try{primed=await timeline.at(target);}catch(error){timeline.close();throw error;}
      this.primed?.frame?.close();this.timeline.close();this.timeline=timeline;this.primed=primed;
    }
    return this.decoderInfo();
  }
  /** Restore WebCodecs without reopening the MP4 input or rebuilding its sample table. */
  async switchToNative(){
    if(this.timeline?.decoder.kind==='ffmpeg-wasm'&&this.nativeConfig){
      const decoder=await nativePacketDecoder(this.index,this.nativeConfig);
      if(decoder){
        const timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size),true);
        const target=this.primed?.pts??this.index.packets[this.index.order[0]].pts;
        let primed:PacketFrame;
        try{primed=await timeline.at(target);}catch(error){timeline.close();if(error instanceof MediaOpenError&&error.stage==='decode')return this.decoderInfo();throw error;}
        this.primed?.frame?.close();this.timeline.close();this.timeline=timeline;this.primed=primed;
      }
    }
    return this.decoderInfo();
  }
  private decoderInfo(){
    const decoder=this.timeline!.decoder;
    return {codec:this.index.codec,decoder:decoder.kind,width:this.displayed(this.primed!).width,height:this.displayed(this.primed!).height,
      hardwareAcceleration:decoder.hardwareAcceleration,...decoder.metadata?.(),
      decodedPixelFormat:this.primed!.frame?.format??this.primed!.description.format??null};
  }
  extract(position:number,recycle?:ArrayBuffer){
    if(!Number.isInteger(position)||position<0||position>=this.index.order.length)throw new MediaOpenError('input','MP4 帧位置越界。');
    return this.at(this.index.packets[this.index.order[position]].pts,recycle);
  }
  close(){this.primed?.frame?.close();this.primed=null;this.timeline?.close();this.timeline=undefined;this.controller.abort();this.reader.close();}
}
