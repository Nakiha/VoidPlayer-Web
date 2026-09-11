import type { MediaOpenProgress } from './media-progress.ts';
import { Input, CustomSource, MP4, QTFF, EncodedPacketSink } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import { MediaOpenError } from './media-errors.ts';
import { RangeReader } from './range-reader.ts';
import type { RandomAccessInput } from './range-reader.ts';
import { readMp4Configurations } from './mp4-config.ts';
import { wasmFlvDecoder, nativeFlvDecoder } from './flv-decoder.ts';
import { hevcDisplayOrder, recoveredHevcTimes } from './hevc-timeline.ts';
import type { FlvFrame } from './flv-decoder.ts';
import type { FlvCodec, FlvIndex, FlvPacket } from './flv-demux.ts';
import { PacketTimeline } from './packet-timeline.ts';

/** Packet tables are decode anchors; actual output frames own display time. */
export class Mp4Engine {
  private reader:RangeReader;
  private input:Input;
  private sink!:EncodedPacketSink;
  private packets:EncodedPacket[]=[];
  private index!:FlvIndex;
  private timeline?:PacketTimeline;
  private primed:FlvFrame|null=null;
  constructor(source:RandomAccessInput){
    this.reader=new RangeReader(source);
    this.input=new Input({source:new CustomSource({getSize:()=>this.reader.size,read:(start,end)=>this.reader.read(start,end-start),maxCacheSize:1024*1024}),formats:[MP4,QTFF]});
  }
  async open(glueURL:string,wasmBinary?:Uint8Array,forceWasm=true,threads=1,onProgress?:MediaOpenProgress){
    try{
      onProgress?.('inspect');
      try{await this.input.getFormat();}catch(error){if(error instanceof MediaOpenError)throw error;throw new MediaOpenError('container','不是可通过 MP4 索引读取的文件。');}
      const track=await this.input.getPrimaryVideoTrack();if(!track)throw new MediaOpenError('container','MP4 没有视频轨道。');
      if(track.rotation!==0)throw new MediaOpenError('container','旋转 MP4 需要容器展示路径。');
      const id=await track.getInternalCodecId(),known=await track.getCodec();
      const codec:FlvCodec=id==='vvc1'||id==='vvi1'?'vvc':({avc:'h264',hevc:'hevc',av1:'av1'} as Record<string,FlvCodec>)[known??''];
      if(!codec)throw new MediaOpenError('codec','此 MP4 编码需要 FFmpeg 解封装。');
      const configs=await readMp4Configurations(this.reader,track.id);
      const available = configs.availableSamples ?? configs.sampleSizes!.length;
      const truncated = available < configs.sampleSizes!.length;
      onProgress?.('index');this.sink=new EncodedPacketSink(track);
      for await(const packet of this.sink.packets(undefined,undefined,{metadataOnly:true})){
        this.packets.push(packet);if(this.packets.length===available)break;if(this.packets.length>2_000_000)throw new MediaOpenError('resource','MP4 包索引超过上限。');
      }
      if(!this.packets.length||this.packets[0].type!=='key')throw new MediaOpenError('container','MP4 缺少起始关键帧。');
      if(available!==this.packets.length)throw new MediaOpenError('container','MP4 包数量与 sample 表不一致。');
      const resolution=await track.getTimeResolution();
      const packets:FlvPacket[]=this.packets.map((p,i)=>{
        const configuration=configs.sampleConfigurations?.[i]??0;
        if(i>0&&configuration!==(configs.sampleConfigurations?.[i-1]??0)&&p.type!=='key')throw new MediaOpenError('container','MP4 配置切换缺少随机访问点。');
        if(configs.sampleSizes?.[i]!==p.byteLength)throw new MediaOpenError('container','MP4 sample 长度与包索引不一致。');
        return {configuration,sequenceNumber:i,offset:configs.sampleOffsets![i],size:p.byteLength,pts:Math.round(p.timestamp*1e6),dts:Math.round(p.timestamp*1e6-(configs.compositionOffsets![i]/resolution)*1e6),key:p.type==='key'};
      });
      const prefixConfigs = { ...configs, sampleOffsets: configs.sampleOffsets!.slice(0, available), sampleSizes: configs.sampleSizes!.slice(0, available), compositionOffsets: configs.compositionOffsets!.slice(0, available) };
      const displayOrder=codec==='hevc'?await hevcDisplayOrder(this.reader,prefixConfigs,()=>onProgress?.('index')):null;
      const recovered=displayOrder&&recoveredHevcTimes(displayOrder,packets.map(p=>p.pts),this.packets.map(p=>Math.round(p.duration*1e6)));
      if(displayOrder&&!recovered)throw new MediaOpenError('container','HEVC 图片顺序与容器时间不一致，但无法从非等距时间线恢复显示时间。');
      if(recovered)packets.forEach((p,i)=>{p.originalPts=p.pts;p.pts=recovered[i];});
      const order=packets.map((_,i)=>i).sort((a,b)=>packets[a].pts-packets[b].pts),pts=order.map(i=>packets[i].pts);
      if(pts.some((p,i)=>i>0&&p<=pts[i-1]))throw new MediaOpenError('container','MP4 包时间戳存在歧义，需要容器解码路径。');
      const durations=order.map((p,i)=>recovered&&i+1<pts.length?pts[i+1]-pts[i]:Math.round(this.packets[p].duration*1e6)||(i+1<pts.length?pts[i+1]-pts[i]:i?pts[i]-pts[i-1]:40000));
      const firstPts=pts[0],duration=pts.at(-1)!-firstPts+durations.at(-1)!;
      this.index={codec,description:configs.descriptions[0],configurations:configs.descriptions,packets,order,firstPts,duration,durations};
      const nativeConfig=!forceWasm&&(recovered||truncated)?await track.getDecoderConfig():null;
      onProgress?.('decoder');const native=nativeConfig&&await nativeFlvDecoder(this.index,nativeConfig);
      const decoder=native||await wasmFlvDecoder(this.index,glueURL,wasmBinary,threads);
      this.timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size));
      onProgress?.('first-frame');this.primed=await this.timeline.at(recovered?firstPts:Math.max(0,firstPts));
      const firstPtsUs=this.primed.pts;
      const color=decoder.kind==='webcodecs'?await track.getColorSpace():null;
      return {codec,decoder:decoder.kind,hardwareAcceleration:decoder.hardwareAcceleration,width:this.primed.width,height:this.primed.height,...decoder.metadata?.(),
        ...(color?{colorSource:'container' as const,color:{primaries:color.primaries??null,transfer:color.transfer??null,matrix:color.matrix??null,fullRange:color.fullRange??null}}:{}),
        ...(recovered?{timelineSource:'hevc-poc' as const}:{}),
        indexWarning: [configs.warning, recovered ? '容器未记录图片重排时间，已按 HEVC 图片顺序恢复等距时间线。' : undefined].filter(Boolean).join(' ') || undefined,
        firstPtsUs,durationUs:firstPts+duration-firstPtsUs,times:pts.filter(p=>p>=firstPtsUs).map(p=>p-firstPtsUs),durations};
    }catch(error){this.close();throw error;}
  }
  async at(pts:number,recycle?:ArrayBuffer){
    if(this.primed&&this.primed.pts===pts){const f=this.primed;this.primed=null;return f;}
    this.primed?.frame?.close();this.primed=null;return this.timeline!.at(pts,recycle);
  }
  next(pts:number,recycle?:ArrayBuffer){return this.timeline!.next(pts,recycle);}
  extract(position:number,recycle?:ArrayBuffer){
    if(!Number.isInteger(position)||position<0||position>=this.index.order.length)throw new MediaOpenError('input','MP4 帧位置越界。');
    return this.at(this.index.packets[this.index.order[position]].pts,recycle);
  }
  close(){this.primed?.frame?.close();this.primed=null;this.timeline?.close();this.timeline=undefined;this.input.dispose();this.reader.close();this.packets=[];}
}
