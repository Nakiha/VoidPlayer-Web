import { MediaOpenError } from './media-errors.ts';
import type { FlvIndex, FlvPacket } from './flv-demux.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';
import { packetDecodeError } from './flv-decoder.ts';
/** Packet metadata chooses a decode anchor, never the identity of an output
 * frame. Only receive() establishes display PTS; playback drains real outputs. */
export class PacketTimeline {
  private cursor=0;
  private configuration=-1;
  private drained=false;
  private started=false;
  private lastPts=-Infinity;
  private deliveredPts:number|null=null;
  private pending:FlvFrame|null=null;
  private failure:unknown;
  private operation=0;
  private actualPacket:FlvPacket|undefined;
  index:FlvIndex;
  readonly decoder:PacketDecoder;
  readonly read:(packet:FlvPacket)=>Promise<Uint8Array>;
  constructor(index:FlvIndex,decoder:PacketDecoder,read:(packet:FlvPacket)=>Promise<Uint8Array>){this.index=index;this.decoder=decoder;this.read=read;}
  replaceIndex(index:FlvIndex){this.index=index;this.pending?.frame?.close();this.pending=null;this.started=false;this.deliveredPts=null;}
  private async configure(id:number){
    if(id!==this.configuration){
      if(this.configuration!==-1||id!==0)await this.decoder.reconfigure?.({codec:this.index.codec,description:this.index.configurations?.[id]??this.index.description});
      this.configuration=id;
    }
    this.decoder.reset();this.drained=false;
  }
  private async start(target:number){
    this.pending?.frame?.close();this.pending=null;
    this.actualPacket=undefined;this.deliveredPts=null;
    const {packets,order}=this.index;
    let lo=0,hi=order.length;
    while(lo<hi){const m=(lo+hi)>>1;if(packets[order[m]].pts<=target)lo=m+1;else hi=m;}
    this.cursor=order[Math.max(0,lo-1)];
    const config=packets[this.cursor].configuration??0;
    while(this.cursor>0&&(packets[this.cursor-1].configuration??0)===config&&(!packets[this.cursor].key||packets[this.cursor].pts>target))this.cursor--;
    await this.configure(config);this.started=true;this.lastPts=-Infinity;
  }
  private async pull(recycle?:ArrayBuffer):Promise<FlvFrame|null>{
    if(this.pending){const f=this.pending;this.pending=null;return f;}
    const {packets}=this.index;
    for(;;){
      const frame=this.decoder.receive(Number.MIN_SAFE_INTEGER,recycle);
      if(frame){
        if(!Number.isSafeInteger(frame.pts)||frame.pts<=this.lastPts){frame.frame?.close();throw new MediaOpenError('decode',`解码输出显示顺序无效：${frame.pts} <= ${this.lastPts}`);}
        this.lastPts=frame.pts;return frame;
      }
      const packet=packets[this.cursor];
      if(!packet||(packet.configuration??0)!==this.configuration){
        if(!this.drained){this.drained=true;await this.decoder.drain();continue;}
        if(!packet)return null;
        await this.configure(packet.configuration??0);continue;
      }
      this.actualPacket=packet;this.cursor++;
      // Random access starts at a CRA; negative-leading HEVC/VVC pictures can
      // reference the previous GOP, so retain the explicit anchor boundary.
      if((this.index.codec==='hevc'||this.index.codec==='vvc')&&packet.pts<this.index.packets[this.anchorIndex()].pts)continue;
      await this.decoder.send(await this.read(packet),packet);
    }
  }
  private anchor=0;
  private anchorIndex(){return this.anchor;}
  async at(target:number,recycle?:ArrayBuffer):Promise<FlvFrame>{
    return this.run(target,async()=>{
      await this.start(target);this.anchor=this.cursor;
      let previous:FlvFrame|null=null;
      try{
        for(;;){
          const f=await this.pull(recycle);recycle=undefined;
          if(!f){if(previous){this.deliveredPts=previous.pts;return previous;}throw new MediaOpenError('decode','解码器没有输出可显示帧。');}
          if(f.pts>=target){if(f.pts===target||!previous){previous?.frame?.close();this.deliveredPts=f.pts;return f;}this.pending=f;this.deliveredPts=previous.pts;return previous;}
          previous?.frame?.close();previous=f;
        }
      }catch(error){previous?.frame?.close();throw error;}
    });
  }
  async next(after:number,recycle?:ArrayBuffer):Promise<FlvFrame|null>{
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
      const failure=packetDecodeError(error,`解码操作 ${operation}，目标 PTS=${target}，实际包 offset=${p?.offset}, bytes=${p?.size}, PTS=${p?.pts}, DTS=${p?.dts}, config=${this.configuration}，实际输出 PTS=${this.lastPts}`);
      if(failure.stage==='decode'||failure.stage==='resource')this.failure=failure;throw failure;
    }
  }
  close(){this.pending?.frame?.close();this.pending=null;this.decoder.close();}
}
