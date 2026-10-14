import {nalRanges} from './nal-framing.ts';
import {abortableWait} from './media-abort.ts';
import {MediaOpenError} from './media-errors.ts';
import {TsPacketSource,readTsPesClocks,TsCombinationNotMigrated,TsSourceChangedError} from './ts-packet-source.ts';
import type {TsPacketReader} from './ts-packet-source.ts';
import {TS_PACKET_BUILD,parseTsPacketIndex} from './ts-packet-index.ts';
import type {TsPacketIndex,TsPacketRecord} from './ts-packet-index.ts';
import {staticTsPsi} from './ts-static-psi.ts';
import {sealJsIndex,isSealedJsIndex} from './js-index-proof.ts';

const error=(message:string):never=>{throw new MediaOpenError('container',`JS MPEG-2 TS: ${message}`);};
function startCodes(bytes:Uint8Array){const result:{at:number;type:number}[]=[];for(let at=0;at+3<bytes.length;at++)if(!bytes[at]&&!bytes[at+1]&&bytes[at+2]===1){result.push({at,type:bytes[at+3]});at+=2;}return result;}
function picture(bytes:Uint8Array){
  const headers=startCodes(bytes).filter(s=>s.type===0);
  if(headers.length!==1||headers[0].at+6>bytes.length)throw new TsCombinationNotMigrated('MPEG-2 TS requires one complete picture per PES');
  for(const code of startCodes(bytes))if(code.type===0xb5&&bytes[code.at+4]>>4===8){if(code.at+9>bytes.length)error('truncated picture coding extension');if((bytes[code.at+6]&3)!==3)throw new TsCombinationNotMigrated('MPEG-2 field pictures require explicit output mapping');}
  const kind=bytes[headers[0].at+5]>>3&7;if(kind<1||kind>3)error('invalid picture coding type');return kind;
}
function sequence(bytes:Uint8Array){
  const codes=startCodes(bytes),parts:Uint8Array[]=[];
  for(let i=0;i<codes.length;i++){const c=codes[i];if(c.type===0)break;
    if(c.type===0xb3||c.type===0xb5&&[1,3].includes(bytes[c.at+4]>>4))parts.push(bytes.subarray(c.at,codes[i+1]?.at??bytes.length));
  }
  const length=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(length);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;
}
/** Finite MPEG-2 adapter for the established TS product sample. PSI and raw PES
 * clocks share the validators used by AVC/HEVC. Each payload read owns a cursor;
 * no FFmpeg container entry or retained compressed-file buffer is involved. */
export class Mpeg2TsPacketSource {
  index?:TsPacketIndex;nativeConfig:VideoDecoderConfig|undefined;bytesRead=0;packetsRead=0;indexReused=false;
  private closed=false;private checkPsi?:ReturnType<typeof staticTsPsi>;
  private abort=()=>this.close();
  private reader:TsPacketReader;private version:string;private signal:AbortSignal;
  constructor(reader:TsPacketReader,version:string,signal:AbortSignal){this.reader=reader;this.version=version;this.signal=signal;signal.throwIfAborted();signal.addEventListener('abort',this.abort,{once:true});}
  private async read(at:number,n:number){this.signal.throwIfAborted();if(this.closed)error('source closed');
    if(!Number.isSafeInteger(at)||at<0||n<0||n>32*1024*1024||at+n>this.reader.size)error('read bounds');
    const bytes=await abortableWait(this.reader.read(at,n),this.signal);this.signal.throwIfAborted();if(bytes.length!==n)error('short read');this.bytesRead+=n;return bytes;
  }
  private async payload(start:number,end:number,pid:number){
    const parts:Uint8Array[]=[];let total=0,first=true,counter:number|undefined,pesLength:number|undefined;
    for(let base=start;base<end;base+=188*1024){const bytes=await this.read(base,Math.min(188*1024,end-base));this.checkPsi!(bytes);
      for(let at=0;at<bytes.length;at+=188){if(bytes[at]!==0x47)error('sync mismatch');if(((bytes[at+1]&31)*256+bytes[at+2])!==pid)continue;
        const control=bytes[at+3]>>4&3;if(!control||bytes[at+1]&128||bytes[at+3]&192)error('invalid transport');
        let p=at+4;if(control&2){const length=bytes[p++];if(p+length>at+188||length&&bytes[p]&128)error('invalid/discontinuous adaptation');p+=length;}
        if(!(control&1)||p===at+188)continue;
        const cc=bytes[at+3]&15;if(counter!==undefined&&cc!==(counter+1)%16)error('continuity gap');counter=cc;
        if(first){if(!(bytes[at+1]&64)||p+9>at+188||bytes[p]||bytes[p+1]||bytes[p+2]!==1||bytes[p+3]<0xe0||bytes[p+3]>0xef||bytes[p+6]>>6!==2)error('invalid PES start');
          const header=9+bytes[p+8],declared=bytes[p+4]*256+bytes[p+5];if(p+header>at+188)error('split PES header');if(declared){pesLength=declared+6-header;if(pesLength<0)error('invalid PES length');}p+=header;first=false;
        }else if(bytes[at+1]&64)error('multiple PES in packet range');
        const part=bytes.slice(p,at+188);total+=part.length;if(total>8*1024*1024)throw new MediaOpenError('resource','MPEG-2 PES payload budget');parts.push(part);
      }
    }
    if(first||pesLength!==undefined&&pesLength!==total)error('truncated PES payload');const out=new Uint8Array(total);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}this.packetsRead++;return out;
  }
  async open(cached?:unknown,progress?:(p:{packets:number;scannedBytes:number;totalBytes:number;bytesRead:number})=>void):Promise<TsPacketIndex>{
    try{if(!this.version||this.reader.size%188)error('missing source identity or partial transport');
      this.checkPsi=staticTsPsi(await this.read(0,Math.min(188*348,this.reader.size)));const streams=this.checkPsi.videoStreams;
      if(streams.length!==1||streams[0].type!==2)throw new TsCombinationNotMigrated('MPEG-2 adapter requires one declared MPEG-2 video track');const pid=streams[0].pid;
      const restored=parseTsPacketIndex(cached,this.version,this.reader.size);
      if(restored&&restored.codec==='mpeg2video'&&isSealedJsIndex(restored)){
        if(restored.pid!==pid)throw new TsSourceChangedError();this.index=restored;
        await this.readUnit(0);this.indexReused=true;return restored;
      }
      const clocks=await readTsPesClocks({size:this.reader.size,read:(a,n)=>this.read(a,n),close(){}},pid,this.signal),entries=[...clocks],packets:TsPacketRecord[]=[];let configuration:Uint8Array|undefined;
      for(let au=0;au<entries.length;au++){
        const [start,clock]=entries[au],end=entries[au+1]?.[0]??this.reader.size;
        if(clock.pts===null)throw new TsCombinationNotMigrated('MPEG-2 packet needs an original PES presentation timestamp');
        const bytes=await this.payload(start,end,pid),kind=picture(bytes),config=sequence(bytes);
        if(!configuration){if(!config.length||kind!==1)error('first picture requires a sequence header and intra picture');configuration=config;}
        else if(config.length&&(config.length!==configuration.length||config.some((b,i)=>b!==configuration![i])))throw new TsCombinationNotMigrated('MPEG-2 sequence changes require configuration segments');
        const ptsUs=Math.round(clock.pts*1e6/90000);
        packets.push({au,locator:start,transportEnd:end,pesOffset:start,configuration:0,timestamp:ptsUs/1e6,ptsUs,durationUs:0,size:bytes.length,key:kind===1,timing:{...clock,timebase:[1,90000],origin:'pes'}});
        if(au%128===0)progress?.({packets:au+1,scannedBytes:end,totalBytes:this.reader.size,bytesRead:this.bytesRead});
      }
      if(!configuration||!packets.length||new Set(packets.map(p=>p.ptsUs)).size!==packets.length)error('empty or ambiguous packet enumeration');
      const order=[...packets].sort((a,b)=>a.ptsUs-b.ptsUs);for(let i=0;i<order.length;i++)order[i].durationUs=i+1<order.length?order[i+1].ptsUs-order[i].ptsUs:i?order[i-1].durationUs:0;
      this.index=sealJsIndex<TsPacketIndex>({schema:2,kind:'js-ts-packets',build:TS_PACKET_BUILD,sourceVersion:this.version,size:this.reader.size,streamKey:'video:0',pid,codec:'mpeg2video',configuration:[...configuration!],packets,completeness:{state:'complete',packets:packets.length}});
      progress?.({packets:packets.length,scannedBytes:this.reader.size,totalBytes:this.reader.size,bytesRead:this.bytesRead});return this.index;
    }catch(e){this.close();throw e;}
  }
  async readUnit(au:number){const p=this.index?.packets[au];if(!p||!Number.isSafeInteger(au))throw new MediaOpenError('container','MPEG-2 AU outside index');
    const bytes=await this.payload(p.locator,p.transportEnd!,this.index!.pid);
    const clocks=await readTsPesClocks({size:188,read:()=>this.read(p.locator,188),close(){}},this.index!.pid,this.signal),raw=clocks.get(0);
    if(bytes.length!==p.size||picture(bytes)===1!==p.key||raw?.pts!==p.timing.pts||raw?.dts!==p.timing.dts)error('packet/index mismatch');return bytes;
  }
  close(){if(this.closed)return;this.closed=true;this.signal.removeEventListener('abort',this.abort);this.index=undefined;this.reader.close();}
}
export async function createTsPacketSource(reader:TsPacketReader,version:string,signal:AbortSignal){
  try{const prefix=await abortableWait(reader.read(0,Math.min(188*348,reader.size)),signal),psi=staticTsPsi(prefix);
    return psi.videoStreams.length===1&&psi.videoStreams[0].type===2?new Mpeg2TsPacketSource(reader,version,signal):new TsPacketSource(reader,version,signal);
  }catch(e){reader.close();throw e;}
}

/** Delay adapter probing until payload is needed. A completely cached analysis
 * range must remain metadata-only and must not read a startup transport window. */
export class TsContainerPacketSource {
  private source?:TsPacketSource|Mpeg2TsPacketSource;
  private closed=false;index?:TsPacketIndex;
  private progress?:Parameters<TsPacketSource['open']>[1];private readBytes=0;private scanned=0;private scannedPackets=0;private lastProgress=-Infinity;
  private publish(force=false){const now=performance.now();if(this.progress&&(force||now-this.lastProgress>=25)){this.lastProgress=now;this.progress({packets:this.scannedPackets,scannedBytes:this.scanned,totalBytes:this.reader.size,bytesRead:this.readBytes});}}
  private reader:TsPacketReader;private version:string;private signal:AbortSignal;
  constructor(reader:TsPacketReader,version:string,signal:AbortSignal){let released=false;this.reader={size:reader.size,read:async(at,n)=>{const bytes=await abortableWait(reader.read(at,n),signal);this.readBytes+=bytes.length;this.scanned=Math.max(this.scanned,at+bytes.length);this.publish();return bytes;},close(){if(!released){released=true;reader.close();}}};this.version=version;this.signal=signal;}
  get nativeConfig(){return this.source?.nativeConfig;}
  get packetsRead(){return this.source?.packetsRead??0;}
  get bytesRead(){return this.readBytes;}
  get indexReused(){return this.source?.indexReused??false;}
  private async transportEnd(){
    const aligned=Math.floor(this.reader.size/188)*188;
    const prefix=await abortableWait(this.reader.read(0,Math.min(188*348,aligned)),this.signal);let validPrefix=0;while(validPrefix+188<=prefix.length&&prefix[validPrefix]===0x47)validPrefix+=188;
    const psi=staticTsPsi(prefix.subarray(0,validPrefix));
    for(let at=0;at<aligned;at+=188*1024){const n=Math.min(188*1024,aligned-at),bytes=await abortableWait(this.reader.read(at,n),this.signal);
      if(bytes.length!==n)throw new MediaOpenError('input','Short TS source read');
      let valid=0;while(valid<n&&bytes[valid]===0x47)valid+=188;psi(bytes.subarray(0,valid));
      if(valid<n)return {limit:at+valid,damage:'gap' as const};
    }
    return {limit:aligned,damage:aligned===this.reader.size?undefined:'short' as const};
  }
  private bounded(limit:number):TsPacketReader{return{size:limit,read:(at,n)=>this.reader.read(at,n),close:()=>this.reader.close()};}
  async open(cached?:unknown,progress?:Parameters<TsPacketSource['open']>[1]){
    try{
      this.progress=progress;
      if(this.closed)error('source closed');
      const restored=parseTsPacketIndex(cached,this.version,this.reader.size),trusted=restored&&isSealedJsIndex(restored)?restored:undefined;
      let {limit,damage}=trusted?{limit:trusted.transportLimit??this.reader.size,damage:undefined}:await this.transportEnd();
      // A short last transport packet may contain part of the final PES. Drop
      // only that unconfirmed AU. A large invalid tail/gap quarantines the last
      // GOP below, so no concealed/dangling B picture becomes a valid result.
      if(damage==='short'){
        const prefix=await abortableWait(this.reader.read(0,Math.min(188*348,limit)),this.signal),streams=staticTsPsi(prefix).videoStreams;
        if(streams.length!==1)throw new TsCombinationNotMigrated('requires one video stream');
        let finalPes=-1;
        for(let at=0;at<limit;at+=188*1024){const bytes=await abortableWait(this.reader.read(at,Math.min(188*1024,limit-at)),this.signal);
          for(let p=0;p<bytes.length;p+=188)if(((bytes[p+1]&31)*256+bytes[p+2])===streams[0].pid&&(bytes[p+1]&64))finalPes=at+p;
        }
        if(finalPes<188)error('no complete TS prefix');limit=finalPes;
      }
      const reader=this.bounded(limit);this.source=await createTsPacketSource(reader,this.version,this.signal);
      if(this.closed){this.source.close();error('source closed');}
      const inner=trusted?sealJsIndex({...trusted,size:limit,indexIntegrity:undefined,indexTruncatedAt:undefined,transportLimit:undefined}):undefined;
      let index=await this.source.open(inner,p=>{this.scannedPackets=Math.max(this.scannedPackets,p.packets);this.scanned=Math.max(this.scanned,p.scannedBytes);this.publish(true);});
      if(damage==='gap'){
        let key=index.packets.findLastIndex(p=>p.key);
        if(index.codec==='hevc')for(let au=index.packets.length-1;au>Math.max(key,index.packets.length-512);au--){
          const bytes=await this.source.readUnit(au);
          if(nalRanges('hevc',Uint8Array.from(index.configuration),bytes).some(n=>{const type=bytes[n.offset]>>1&63;return type>=16&&type<=23;})){key=au;break;}
        }
        if(key<=0)error('no safe complete GOP before transport damage');
        limit=index.packets[key].pesOffset!;
        if(!Number.isSafeInteger(limit)||limit<188)error('missing prefix PES boundary');
        const packets=index.packets.slice(0,key);
        index=sealJsIndex({...index,packets,completeness:{state:'complete' as const,packets:packets.length}});
      }
      this.index=trusted??(damage?sealJsIndex({...index,size:this.reader.size,indexIntegrity:'prefix' as const,indexTruncatedAt:limit,transportLimit:limit}):index);
      this.publish(true);return this.index;
    }catch(e){this.close();throw e;}finally{this.progress=undefined;}
  }
  readUnit(au:number){if(!this.source||!this.index?.packets[au])throw new MediaOpenError('container','TS AU outside playable prefix');return this.source.readUnit(au);}
  close(){if(this.closed)return;this.closed=true;this.index=undefined;if(this.source)this.source.close();else this.reader.close();}
}
