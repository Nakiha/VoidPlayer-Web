import {CustomSource,Input,MATROSKA,WEBM,EncodedPacketSink} from 'mediabunny';
import type {EncodedPacket} from 'mediabunny';
import type {TsPacketReader} from './ts-packet-source.ts';
import {TsCombinationNotMigrated,TsSourceChangedError} from './ts-packet-source.ts';
import {MediaOpenError} from './media-errors.ts';
import {abortableWait} from './media-abort.ts';
import {matroskaClocks} from './matroska-clocks.ts';
import {MATROSKA_PACKET_BUILD,parseMatroskaPacketIndex} from './matroska-packet-index.ts';
import type {MatroskaPacketIndex,MatroskaPacketRecord} from './matroska-packet-index.ts';
import {inspectPacketPicture} from './packet-picture.ts';
import {avcGeometry} from './avc-geometry.ts';
import {nalRanges} from './nal-framing.ts';
import {HevcPictureOrder,UnsupportedHevcPictureStructure} from './hevc-timeline.ts';
import {hevcFieldPictures} from './hevc-geometry.ts';
import {sealJsIndex,isSealedJsIndex} from './js-index-proof.ts';

const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
export class MatroskaPacketSource {
  private input:Input;private sink?:EncodedPacketSink;private closed=false;
  private cursor?:{au:number;packet:EncodedPacket};
  index?:MatroskaPacketIndex;nativeConfig?:VideoDecoderConfig;bytesRead=0;packetsRead=0;indexReused=false;
  private sets=new Map<number,Uint8Array>();private indexingBytes:number|undefined;
  private progress?: (p:{packets:number;scannedBytes:number;totalBytes:number;bytesRead:number})=>void;private scannedBytes=0;private lastProgress=-Infinity;
  private abort=()=>this.close();
  private reader:TsPacketReader;private version:string;private signal:AbortSignal;
  constructor(reader:TsPacketReader,version:string,signal:AbortSignal){
    this.reader=reader;this.version=version;this.signal=signal;
    try{signal.throwIfAborted();if(!version||!Number.isSafeInteger(reader.size)||reader.size<=0)throw new MediaOpenError('input','Missing JS source identity/size');
      this.input=new Input({formats:[MATROSKA,WEBM],source:new CustomSource({getSize:()=>reader.size,read:(a,b)=>this.read(a,b-a),maxCacheSize:1024*1024})});
      signal.addEventListener('abort',this.abort,{once:true});
    }catch(error){reader.close();throw error;}
  }
  private check(){this.signal.throwIfAborted();if(this.closed)throw new MediaOpenError('input','JS Matroska source closed');}
  private async read(at:number,length:number){this.check();if(!Number.isSafeInteger(at)||!Number.isSafeInteger(length)||at<0||length<0||length>32*1024*1024||at+length>this.reader.size)throw new MediaOpenError('resource','JS Matroska read bounds');
    const bytes=await abortableWait(this.reader.read(at,length),this.signal);this.check();if(bytes.length!==length)throw new MediaOpenError('input','Short Matroska read');this.bytesRead+=bytes.length;
    if(this.indexingBytes!==undefined){this.indexingBytes+=bytes.length;if(this.indexingBytes>this.reader.size*4+32*1024*1024)throw new MediaOpenError('resource','Matroska index IO budget');
      this.scannedBytes=Math.max(this.scannedBytes,at+length);const now=performance.now();if(this.progress&&now-this.lastProgress>=25){this.lastProgress=now;this.progress({packets:this.packetsRead,scannedBytes:this.scannedBytes,totalBytes:this.reader.size,bytesRead:this.bytesRead});}}
    return bytes;}
  private picture(bytes:Uint8Array,codec:MatroskaPacketIndex['codec'],configuration:Uint8Array){
    const evidence=inspectPacketPicture(codec,configuration,bytes);
    if(!evidence.singlePicture){if(evidence.reason?.startsWith('unsupported-'))throw new TsCombinationNotMigrated(`Matroska picture layout: ${evidence.reason}`);throw new MediaOpenError('container',`Invalid Matroska picture: ${evidence.reason}`);}
    if(codec==='h264'||codec==='hevc')for(const nal of nalRanges(codec,configuration,bytes)){
      const data=bytes.subarray(nal.offset,nal.offset+nal.size),type=codec==='h264'?data[0]&31:data[0]>>1&63;
      if(!(codec==='h264'?[7,8]:[32,33,34]).includes(type))continue;
      if(!this.sets.has(type)||!equal(this.sets.get(type)!,data))throw new TsCombinationNotMigrated('Matroska in-band configuration changes require separate admission');
    }
    return evidence;
  }
  private configurationSets(codec:string,description:Uint8Array){
    if(codec!=='h264'&&codec!=='hevc')return;let at=codec==='h264'?6:23;
    const read=(length:number)=>{if(at+length>description.length)throw new MediaOpenError('container','Truncated Matroska configuration');const result=description.subarray(at,at+length);at+=length;return result;};
    const add=(type:number,count:number)=>{for(let i=0;i<count;i++){const n=read(2),data=read(n[0]*256+n[1]);if(this.sets.has(type))throw new TsCombinationNotMigrated('Multiple Matroska parameter sets require separate admission');this.sets.set(type,data.slice());}};
    if(codec==='h264'){if(description.length<7||description[0]!==1)throw new MediaOpenError('container','Invalid Matroska avcC');add(7,description[5]&31);add(8,read(1)[0]);}
    else{if(description.length<23||description[0]!==1)throw new MediaOpenError('container','Invalid Matroska hvcC');for(let i=0;i<description[22];i++){const type=read(1)[0]&63,n=read(2),count=n[0]*256+n[1];if([32,33,34].includes(type))add(type,count);else for(let j=0;j<count;j++){const len=read(2);read(len[0]*256+len[1]);}}}
    if(!(codec==='h264'?[7,8]:[32,33,34]).every(type=>this.sets.has(type)))throw new MediaOpenError('container','Missing Matroska static parameter sets');
  }
  async open(cached?:unknown,progress?:(p:{packets:number;scannedBytes:number;totalBytes:number;bytesRead:number})=>void):Promise<MatroskaPacketIndex>{
    try{this.indexingBytes=0;this.progress=progress;this.check();await this.input.getFormat();const tracks=await this.input.getVideoTracks();
      if(tracks.length!==1)throw new TsCombinationNotMigrated('Matroska requires one video track');
      const track=tracks[0],name=await track.getCodec(),codec=name==='avc'?'h264':name;
      if(codec!=='h264'&&codec!=='hevc'&&codec!=='vp8'&&codec!=='vp9')throw new TsCombinationNotMigrated(`Matroska codec ${await track.getInternalCodecId()} is not migrated`);
      this.nativeConfig=await track.getDecoderConfig()??undefined;
      const raw=this.nativeConfig?.description,configuration=raw?ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength).slice():new Uint8Array(raw).slice():new Uint8Array();
      if((codec==='h264'||codec==='hevc')&&!configuration.length)throw new MediaOpenError('container','Missing Matroska CodecPrivate');
      if(configuration.length>4096)throw new MediaOpenError('resource','Matroska configuration budget');
      this.configurationSets(codec,configuration);
      if(codec==='hevc')try{new HevcPictureOrder(configuration);if(hevcFieldPictures(configuration))throw new UnsupportedHevcPictureStructure('HEVC field pictures require separate admission');}catch(error){if(error instanceof UnsupportedHevcPictureStructure)throw new TsCombinationNotMigrated(error.message);throw new MediaOpenError('container','Invalid Matroska HEVC configuration');}
      if(codec==='h264'&&avcGeometry(configuration)?.interlaced)throw new TsCombinationNotMigrated('Interlaced Matroska AVC requires separate admission');
      this.sink=new EncodedPacketSink(track);const first=await this.sink.getFirstPacket();this.check();
      if(!first||!this.picture(first.data,codec,configuration).closedRandomAccess)throw new MediaOpenError('container','Matroska first picture must prove closed random access');
      const restored=parseMatroskaPacketIndex(cached,this.version,this.reader.size);
      if(restored&&isSealedJsIndex(restored)){
        if(restored.pid!==track.id||restored.codec!==codec||!equal(Uint8Array.from(restored.configuration),configuration)||restored.packets[0].locator!==first.sequenceNumber||restored.packets[0].size!==first.byteLength||restored.packets[0].timestamp!==first.timestamp)throw new TsSourceChangedError();
        this.index=sealJsIndex(restored);this.indexReused=true;this.cursor={au:0,packet:first};return this.index;
      }
      const clocks=await matroskaClocks({size:this.reader.size,read:(at,n)=>this.read(at,n),close(){}},track.id,this.signal),packets:MatroskaPacketRecord[]=[];
      for await(const packet of this.sink.packets()){
        this.check();if(packets.length>=250000||packet.byteLength>32*1024*1024)throw new MediaOpenError('resource','Matroska index/AU budget');
        const raw=clocks.get(packet.sequenceNumber),ptsUs=Math.round(packet.timestamp*1e6),durationUs=Math.round(packet.duration*1e6);
        if(!raw||raw.size!==packet.byteLength||Math.round(raw.pts*raw.timebase[0]/1000)!==ptsUs||!Number.isSafeInteger(raw.pts*raw.timebase[0])||!Number.isSafeInteger(durationUs)||durationUs<0||packets.length&&packet.sequenceNumber<=packets.at(-1)!.locator)throw new MediaOpenError('container','Matroska block/packet clock or locator mismatch');
        const picture=this.picture(packet.data,codec,configuration);
        packets.push({au:packets.length,locator:packet.sequenceNumber,configuration:0,blockOffset:raw.blockOffset,timestamp:packet.timestamp,ptsUs,durationUs,size:packet.byteLength,key:picture.closedRandomAccess,timing:{pts:raw.pts,dts:null,timebase:raw.timebase,origin:'matroska-block'}});this.packetsRead++;
        if(packets.length%128===0)progress?.({packets:packets.length,scannedBytes:this.scannedBytes,totalBytes:this.reader.size,bytesRead:this.bytesRead});
      }
      if(!packets.length||packets.length!==clocks.size||new Set(packets.map(p=>p.ptsUs)).size!==packets.length)throw new MediaOpenError('container','Incomplete or ambiguous Matroska packet enumeration');
      this.index=sealJsIndex<MatroskaPacketIndex>({schema:1,kind:'js-matroska-packets',build:MATROSKA_PACKET_BUILD,sourceVersion:this.version,size:this.reader.size,streamKey:'video:0',pid:track.id,codec,configuration:[...configuration],packets,completeness:{state:'complete',packets:packets.length}});
      this.cursor={au:0,packet:first};progress?.({packets:packets.length,scannedBytes:this.reader.size,totalBytes:this.reader.size,bytesRead:this.bytesRead});return this.index;
    }catch(error){this.close();this.signal.throwIfAborted();throw error;}finally{this.indexingBytes=undefined;this.progress=undefined;}
  }
  async readUnit(au:number){this.check();const target=this.index?.packets[au];if(!target||!Number.isSafeInteger(au)||au<0)throw new MediaOpenError('input','Matroska AU ordinal out of bounds');
    const packet=this.cursor?.au===au?this.cursor.packet:this.cursor?.au===au-1?await this.sink!.getNextPacket(this.cursor.packet):await this.sink!.getPacket(target.timestamp);this.check();this.packetsRead++;
    if(!packet||packet.sequenceNumber!==target.locator||packet.byteLength!==target.size||Math.round(packet.timestamp*1e6)!==target.ptsUs)throw new MediaOpenError('container','Matroska packet/index identity mismatch');
    const picture=this.picture(packet.data,this.index!.codec,Uint8Array.from(this.index!.configuration));if(target.key&&!picture.closedRandomAccess)throw new MediaOpenError('container','Matroska key does not prove safe anchor');
    this.cursor={au,packet};return packet.data;
  }
  close(){if(this.closed)return;this.closed=true;this.signal.removeEventListener('abort',this.abort);this.cursor=undefined;this.sink=undefined;this.index=undefined;try{this.input.dispose();}finally{this.reader.close();}}
}
