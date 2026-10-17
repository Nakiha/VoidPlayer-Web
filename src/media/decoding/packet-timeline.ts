import type { PacketDecoder, PacketFrame } from './flv-decoder.ts';
import type { PacketDecodeIndex, PacketDecodePacket } from '../../../shared/media/indexing/packet-decode-index.ts';
import { inspectPacketPicture } from '../../../shared/media/codecs/packet-picture.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';
import { packetDecodeError } from './flv-decoder.ts';
/** Packet metadata chooses a decode anchor, never the identity of an output
 * frame. Only receive() establishes display PTS; playback drains real outputs. */
export class PacketTimeline {
  private cursor=0;
  private pictures = new Map<number, import('../../../shared/media/codecs/packet-picture.ts').PacketPicture>();
  private configuration=-1;
  private drained=false;
  private started=false;
  private lastPts=-Infinity;
  private deliveredPts:number|null=null;
  private pending:PacketFrame|null=null;
  private failure:unknown;
  private operation=0;
  private actualPacket:PacketDecodePacket|undefined;
  private segmentStart=0;
  private growth?: () => Promise<void>;
  setGrowth(wait?: () => Promise<void>) { this.growth = wait; }
  appendIndex(index: PacketDecodeIndex) {
    this.index = index;
    for (const [pts, picture] of this.pictures) if (!this.validPicture(pts, picture)) this.pictures.delete(pts);
    if (this.pending?.packetPicture && !this.validPicture(this.pending.pts, this.pending.packetPicture)) this.pending.packetPicture = undefined;
  }
  private validPicture(pts: number, picture: import('../../../shared/media/codecs/packet-picture.ts').PacketPicture) {
    if (!this.identityStable() || picture.stream !== this.pictureStream) return false;
    const { order, packets } = this.index;
    let lo = 0, hi = order.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (packets[order[m]].pts < pts) lo = m + 1; else hi = m; }
    const packet = packets[order[lo]];
    return !!packet && packet.identityKnown !== false && packet.pts === pts && (lo + 1 === order.length || packets[order[lo + 1]].pts !== pts)
      && (packet.sequenceNumber ?? order[lo]) === picture.au && (packet.configuration ?? 0) === picture.configuration;
  }
  index:PacketDecodeIndex;
  readonly decoder:PacketDecoder;
  readonly read:(packet:PacketDecodePacket)=>Promise<Uint8Array>;
  private identifyPictures:boolean;
  private identityStable:()=>boolean;
  private pictureStream:string;
  constructor(index:PacketDecodeIndex,decoder:PacketDecoder,read:(packet:PacketDecodePacket)=>Promise<Uint8Array>,identifyPictures=false,identityStable:()=>boolean=()=>true,pictureStream='video'){this.pictureStream=pictureStream;this.identityStable=identityStable;this.identifyPictures=identifyPictures;this.index=index;this.decoder=decoder;this.read=read;}
  replaceIndex(index:PacketDecodeIndex){this.index=index;this.pending?.frame?.close();this.pending=null;this.started=false;this.deliveredPts=null;}
  private async configure(id:number){
    if(id!==this.configuration){
      if(this.configuration!==-1||id!==0)await this.decoder.reconfigure?.({codec:this.index.codec,codecParameters:this.index.codecConfigurations?.[id]??this.index.codecParameters,description:this.index.configurations?.[id]??this.index.description});
      this.configuration=id;
    }
    this.pictures.clear();this.decoder.reset();this.drained=false;
  }
  private async start(target:number){
    this.pending?.frame?.close();this.pending=null;
    this.actualPacket=undefined;this.deliveredPts=null;
    const {packets,order}=this.index;
    let lo=0,hi=order.length;
    while(lo<hi){const m=(lo+hi)>>1;if(packets[order[m]].pts<=target)lo=m+1;else hi=m;}
    let position=Math.max(0,lo-1);
    // Seek must choose the same first output as sequential playback, even
    // when a later key packet shares PTS with an earlier dependent picture.
    while(position>0&&packets[order[position-1]].pts===packets[order[position]].pts)position--;
    this.cursor=order[position];
    const config=packets[this.cursor].configuration??0;
    while(this.cursor>0&&!packets[this.cursor].discontinuity&&(packets[this.cursor-1].configuration??0)===config&&(!packets[this.cursor].key||packets[this.cursor].pts>target))this.cursor--;
    this.segmentStart=this.cursor;
    await this.configure(config);this.started=true;this.lastPts=-Infinity;
  }
  private async pull(recycle?:ArrayBuffer,minimum=Number.MIN_SAFE_INTEGER):Promise<PacketFrame|null>{
    if(this.pending){const f=this.pending;this.pending=null;if(f.packetPicture&&!this.validPicture(f.pts,f.packetPicture))f.packetPicture=undefined;return f;}
    for(;;){
      const frame=this.decoder.receive(minimum,recycle);
      if(frame){
        if(!Number.isSafeInteger(frame.pts)||frame.pts<this.lastPts){frame.frame?.close();throw new MediaOpenError('decode',`解码输出显示顺序无效：${frame.pts} < ${this.lastPts}`);}
        if(frame.pts===this.lastPts){frame.frame?.close();continue;}
        this.lastPts=frame.pts;
        const picture=this.pictures.get(frame.pts);frame.packetPicture=picture&&this.validPicture(frame.pts,picture)?picture:undefined;this.pictures.delete(frame.pts);return frame;
      }
      const packet=this.index.packets[this.cursor];
      if (!packet && this.growth) { await this.growth(); continue; }
      if(!packet||(packet.configuration??0)!==this.configuration||(packet.discontinuity&&this.cursor!==this.segmentStart)){
        if(!this.drained){this.drained=true;await this.decoder.drain();continue;}
        if(!packet)return null;
        await this.configure(packet.configuration??0);
        this.segmentStart=this.cursor;this.anchor=this.cursor;continue;
      }
      this.actualPacket=packet;
      // Random access starts at a CRA; negative-leading HEVC/VVC pictures can
      // reference the previous GOP, so retain the explicit anchor boundary.
      if((this.index.codec==='hevc'||this.index.codec==='vvc'||this.index.codec==='mpeg2video'||this.index.packets[this.anchorIndex()].discontinuity)&&packet.pts<this.index.packets[this.anchorIndex()].pts){this.cursor++;continue;}
      const bytes=await this.read(packet);
      if (this.identifyPictures && this.pictures.size < 512) {
        const evidence=inspectPacketPicture(this.index.codec,this.index.configurations?.[this.configuration]??this.index.description,bytes);
        let lo=0,hi=this.index.order.length;
        while(lo<hi){const m=(lo+hi)>>>1;if(this.index.packets[this.index.order[m]].pts<packet.pts)lo=m+1;else hi=m;}const position=lo;
        const unique=position>=0 && (position===0||this.index.packets[this.index.order[position-1]].pts!==packet.pts) && (position+1===this.index.order.length||this.index.packets[this.index.order[position+1]].pts!==packet.pts);
        if(evidence.singlePicture&&unique&&packet.identityKnown!==false)this.pictures.set(packet.pts,{au:packet.sequenceNumber??this.cursor,configuration:this.configuration,stream:this.pictureStream});
      }
      if (await this.decoder.send(bytes,packet) !== false) this.cursor++;
    }
  }
  private anchor=0;
  private anchorIndex(){return this.anchor;}
  async at(target:number,recycle?:ArrayBuffer):Promise<PacketFrame>{
    return this.run(target,async()=>{
      await this.start(target);this.anchor=this.cursor;
      // The finite MPEG-2 adapter proves one frame picture per PES with known
      // source PTS. Let the existing WASM receive ABI discard earlier decoded
      // outputs before conversion/copy. Other layouts retain output-led seeks.
      let minimum=Number.MIN_SAFE_INTEGER;
      if(this.index.codec==='mpeg2video'&&this.decoder.kind==='ffmpeg-wasm'){
        const {packets,order}=this.index;let lo=0,hi=order.length;
        while(lo<hi){const m=(lo+hi)>>>1;if(packets[order[m]].pts<=target)lo=m+1;else hi=m;}
        const floor=packets[order[Math.max(0,lo-1)]];
        if(floor&&floor.identityKnown!==false)minimum=floor.pts;
      }
      let previous:PacketFrame|null=null;
      try{
        for(;;){
          const f=await this.pull(recycle,minimum);recycle=undefined;
          if(minimum!==Number.MIN_SAFE_INTEGER&&!previous&&(!f||f.pts>target)){
            // A decoder may omit an indexed picture. Re-decode without any
            // discard threshold to retain the actual preceding output, or the
            // first actual frame when the target precedes all outputs.
            f?.frame?.close();minimum=Number.MIN_SAFE_INTEGER;
            await this.start(target);this.anchor=this.cursor;continue;
          }
          if(!f){if(previous){this.deliveredPts=previous.pts;return previous;}throw new MediaOpenError('decode','解码器没有输出可显示帧。');}
          if(f.pts>=target){if(f.pts===target||!previous){previous?.frame?.close();this.deliveredPts=f.pts;return f;}this.pending=f;this.deliveredPts=previous.pts;return previous;}
          previous?.frame?.close();previous=f;
        }
      }catch(error){previous?.frame?.close();throw error;}
    });
  }
  async next(after:number,recycle?:ArrayBuffer):Promise<PacketFrame|null>{
    return this.run(after,async()=>{
      if(!this.started||this.deliveredPts!==after){
        const f=await this.at(after);
        if(f.pts>after)return f;
        f.frame?.close();
      }
      for(;;){const f=await this.pull(recycle);recycle=undefined;if(!f||f.pts>after){if(f)this.deliveredPts=f.pts;return f;}f.frame?.close();}
    });
  }
  private async run<T>(target:number,work:()=>Promise<T>):Promise<T>{
    if(this.failure)throw this.failure;
    const operation=++this.operation;
    try{return await work();}catch(error){
      const p=this.actualPacket;
      const failure=packetDecodeError(error,`解码操作 ${operation}，目标 PTS=${target}，实际包 offset=${p?.offset}, bytes=${p?.size}, PTS=${p?.pts}, DTS=${p?.dts}, originalPTS=${p?.originalPts??p?.pts}, config=${this.configuration}，实际输出 PTS=${this.lastPts}`);
      if(failure.stage==='decode'||failure.stage==='resource')this.failure=failure;throw failure;
    }
  }
  close(){this.pending?.frame?.close();this.pending=null;this.decoder.close();}
}
