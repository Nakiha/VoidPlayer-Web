import {abortableWait} from '../io/media-abort.ts';
import {MediaOpenError} from '../io/media-errors.ts';
import {TsCombinationNotMigrated,readTsPesClocks} from './ts-packet-source.ts';
import type {TsPacketReader} from './ts-packet-source.ts';
import {TS_PACKET_BUILD,parseTsPacketIndex} from '../indexing/ts-packet-index.ts';
import type {TsPacketIndex,TsPacketRecord} from '../indexing/ts-packet-index.ts';
import {staticTsPsi} from './ts-static-psi.ts';
import {nalRanges} from '../codecs/nal-framing.ts';
import {readTsPesPayload} from './ts-pes-payload.ts';
import {sealJsIndex,isSealedJsIndex} from '../indexing/js-index-proof.ts';
function fail(reason:string):never{throw new MediaOpenError('container',`JS broadcast TS: ${reason}`);}
/** Preserve finite broadcast captures beginning mid-GOP with delayed PSI.
 * Recover only a declared HEVC PID and an actual in-band IRAP/configuration.
 * Original physical offsets/clocks remain source-bound. No exact picture claim. */
export class RecoveredHevcTsPacketSource {
 index?:TsPacketIndex;nativeConfig:VideoDecoderConfig|undefined;bytesRead=0;packetsRead=0;indexReused=false;
 private indexing=false;private closed=false;private checkPsi?:ReturnType<typeof staticTsPsi>;
 private abort=()=>this.close();
 private reader:TsPacketReader;private version:string;private signal:AbortSignal;
 constructor(reader:TsPacketReader,version:string,signal:AbortSignal){this.reader=reader;this.version=version;this.signal=signal;signal.throwIfAborted();signal.addEventListener('abort',this.abort,{once:true});}
 private async read(at:number,n:number){this.signal.throwIfAborted();if(this.closed)fail('closed');if(!Number.isSafeInteger(at)||!Number.isSafeInteger(n)||at<0||n<0||n>32*1024*1024||at+n>this.reader.size)fail('read bounds');const b=await abortableWait(this.reader.read(at,n),this.signal);this.signal.throwIfAborted();if(b.length!==n)fail('short read');this.bytesRead+=n;if(this.indexing&&this.bytesRead>this.reader.size*4+32*1024*1024)throw new MediaOpenError('resource','Broadcast index IO budget');return b;}
 private async payload(start:number,end:number,pid:number){const b=await readTsPesPayload((at,n)=>this.read(at,n),start,end,pid,this.checkPsi!);this.packetsRead++;return b;}
 async open(cached?:unknown,progress?:(p:{packets:number;scannedBytes:number;totalBytes:number;bytesRead:number})=>void):Promise<TsPacketIndex>{
  try{
   this.indexing=true;const prefix=await this.read(0,Math.min(1024*1024,this.reader.size));let offset=-1;
   for(let at=0;at<188&&at+188*3<prefix.length;at++)if([0,1,2,3].every(i=>prefix[at+i*188]===0x47)){offset=at;break;}
   if(offset<0)throw new TsCombinationNotMigrated('bounded recovery requires aligned 188-byte TS');
   const size=Math.floor((this.reader.size-offset)/188)*188,end=offset+size;
   this.checkPsi=staticTsPsi(prefix.subarray(offset,offset+Math.floor((prefix.length-offset)/188)*188));
   const streams=this.checkPsi.videoStreams;if(streams.length!==1||streams[0].type!==36)throw new TsCombinationNotMigrated('late-PSI recovery currently requires one declared HEVC stream');const pid=streams[0].pid;
   const restored=parseTsPacketIndex(cached,this.version,this.reader.size);
   if(restored&&isSealedJsIndex(restored)&&restored.codec==='hevc'&&restored.transportOffset===offset&&restored.exactPictureMapping===false){if(restored.pid!==pid)fail('source PID changed');this.index=restored;const first=await this.readUnit(0),parts=nalRanges('hevc',new Uint8Array([0,0,1]),first).filter(r=>[32,33,34].includes(first[r.offset]>>1&63)).flatMap(r=>[0,0,0,1,...first.subarray(r.offset,r.offset+r.size)]);if(parts.length!==restored.configuration.length||parts.some((b,i)=>b!==restored.configuration[i]))fail('configuration changed');this.indexReused=true;return restored;}
   const clocks=await readTsPesClocks({size,read:(at,n)=>this.read(offset+at,n),close(){}},pid,this.signal),entries=[...clocks],packets:TsPacketRecord[]=[];let configuration:Uint8Array|undefined;
   for(let n=0;n<entries.length;n++){
    const [position,timing]=entries[n],start=offset+position,limit=offset+(entries[n+1]?.[0]??size),bytes=await this.payload(start,limit,pid),ranges=nalRanges('hevc',new Uint8Array([0,0,1]),bytes);
    const vcl=ranges.filter(r=>(bytes[r.offset]>>1&63)<32),key=vcl.some(r=>{const type=bytes[r.offset]>>1&63;return type>=16&&type<=23;});
    if(!vcl.length||vcl.some(r=>r.size<3)||vcl.filter(r=>bytes[r.offset+2]&128).length!==1)throw new TsCombinationNotMigrated('broadcast recovery needs one HEVC picture per PES');
    if(!configuration){
     const sets=ranges.filter(r=>[32,33,34].includes(bytes[r.offset]>>1&63));
     if(!key||![32,33,34].every(type=>sets.some(r=>(bytes[r.offset]>>1&63)===type)))continue;
     const parts=sets.map(r=>bytes.subarray(r.offset,r.offset+r.size)),length=parts.reduce((n,b)=>n+4+b.length,0);if(length>4096)fail('configuration budget');configuration=new Uint8Array(length);let at=0;for(const part of parts){configuration.set([0,0,0,1],at);configuration.set(part,at+4);at+=4+part.length;}
    }
    if(timing.pts===null)throw new TsCombinationNotMigrated('broadcast recovery needs original PES PTS');
    const ptsUs=Math.round(timing.pts*1e6/90000);packets.push({au:packets.length,locator:start,pesOffset:start,transportEnd:limit,configuration:0,timestamp:ptsUs/1e6,ptsUs,durationUs:0,size:bytes.length,key,timing:{...timing,timebase:[1,90000],origin:'pes'}});
    if(packets.length>250000)fail('packet budget');progress?.({packets:packets.length,scannedBytes:limit,totalBytes:this.reader.size,bytesRead:this.bytesRead});
   }
   if(!configuration||!packets.length||new Set(packets.map(p=>p.ptsUs)).size!==packets.length)fail('no recoverable IRAP or ambiguous clocks');
   const order=[...packets].sort((a,b)=>a.ptsUs-b.ptsUs);for(let i=0;i<order.length;i++)order[i].durationUs=i+1<order.length?order[i+1].ptsUs-order[i].ptsUs:i?order[i-1].durationUs:0;
   this.index=sealJsIndex<TsPacketIndex>({schema:2,kind:'js-ts-packets',build:TS_PACKET_BUILD,sourceVersion:this.version,size:this.reader.size,streamKey:'video:0',pid,codec:'hevc',configuration:[...configuration],exactPictureMapping:false,recovery:'hevc-late-psi',transportOffset:offset,packets,completeness:{state:'complete',packets:packets.length},...(end<this.reader.size?{indexIntegrity:'prefix' as const,indexTruncatedAt:end,transportLimit:end}:{})});return this.index;
  }catch(e){this.close();throw e;}finally{this.indexing=false;}
 }
 async readUnit(au:number){const p=this.index?.packets[au];if(!p||!Number.isSafeInteger(au))fail('packet outside recovered prefix');const bytes=await this.payload(p.locator,p.transportEnd!,this.index!.pid);if(bytes.length!==p.size)fail('payload changed');const raw=(await readTsPesClocks({size:188,read:()=>this.read(p.pesOffset!,188),close(){}},this.index!.pid,this.signal)).get(0);if(raw?.pts!==p.timing.pts||raw?.dts!==p.timing.dts)fail('source clocks changed');return bytes;}
 close(){if(this.closed)return;this.closed=true;this.signal.removeEventListener('abort',this.abort);this.index=undefined;this.reader.close();}
}
