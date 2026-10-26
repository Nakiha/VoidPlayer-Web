import {readFileSync,openSync,writeSync,closeSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {openIndexDatabase} from '../../sqlite.ts';import {FrameIndexStore} from '../../frame-index-store.ts';import {libraryPairSource} from '../quality/file-source.ts';
import {parseFlvIndex} from '../../../shared/media/indexing/flv-index-cache.ts';import {qualityTargetForAu} from '../../../shared/analysis/quality/selection.ts';
import {inspectFlvFrame,PAIR_LIMITS} from '../../../shared/analysis/quality/frame-pair.ts';import type {PairTarget} from '../../../shared/analysis/quality/frame-pair.ts';
import {createPairDecoder} from '../../../shared/analysis/quality/wasm-decoder.ts';import {instantiateCore} from '../../../shared/wasm/core.ts';import {validateDescription} from '../../../shared/media/frame-description.ts';
import {CAMBI_LIMITS,CambiError,cambiOutputBudget} from '../../../shared/analysis/quality/cambi.ts';import type {CambiInput,CambiPrepared} from '../../../shared/analysis/quality/cambi.ts';
export async function runCambiDecode(data:{mode:'decode'|'verify';database:string;coreDir:string;directory:string;input:CambiInput;control:SharedArrayBuffer},progress:(frames:number,total:number)=>void){
 const started=performance.now(),control=new Int32Array(data.control),check=()=>{if(Atomics.load(control,0))throw new CambiError('cancelled','CAMBI decode cancelled');if(performance.now()-started>data.input.budget.maxElapsedMs)throw new CambiError('budget-exceeded','CAMBI decode deadline');};
 const db=openIndexDatabase(data.database,{readOnly:true}),store=new FrameIndexStore(db);let indexBytes=0,indexPackets=0;
 const open=(t:PairTarget)=>{check();const v=libraryPairSource(db,store,t,{...PAIR_LIMITS,maxIndexBytes:Math.min(PAIR_LIMITS.maxIndexBytes,CAMBI_LIMITS.maxIndexBytes-indexBytes),maxIndexPackets:PAIR_LIMITS.maxIndexPackets},control);indexBytes+=Buffer.byteLength(JSON.stringify(v.source.index));indexPackets+=v.source.index!.packets.length;if(indexBytes>CAMBI_LIMITS.maxIndexBytes||indexPackets>CAMBI_LIMITS.maxIndexPackets){v.source.close();throw new CambiError('budget-exceeded','Cumulative CAMBI index budget');}return v;};
 const dummy={...data.input.source,sourcePtsUs:0,picture:{sourceVersion:`${data.input.source.mediaId}@${data.input.source.mediaVersion}`,stream:'video',configuration:0,au:0,picture:0,layer:0,field:'frame'}} as PairTarget;
 try{
  const first=open(dummy);let index,binding;try{index=parseFlvIndex(first.source.index!,data.input.source.size);binding=first.proof;}finally{first.source.close();}
  if(data.mode==='verify')return {indexBytes,indexPackets};
  const {startPtsUs,endPtsUs}=data.input.interval,rows=index.packets.flatMap((p,au)=>p.pts>=startPtsUs&&p.pts<endPtsUs?[{au,p}]:[]);
  if(!rows.length)throw new CambiError('no-results','No indexed pictures in the declared interval');
  if(rows.length>CAMBI_LIMITS.intervalAus)throw new CambiError('budget-exceeded','Interval exceeds 256 indexed AUs');
  const counts=new Map<number,number>();for(const p of index.packets)counts.set(p.pts,(counts.get(p.pts)??0)+1);
  const targets:PairTarget[]=[],unsupported:CambiPrepared['coverage']['unsupported']=[];let unsampled=0;
  for(const [ordinal,{au,p}]of rows.entries()){
   if(ordinal%data.input.sampling.stride){unsampled++;continue;}
   const value=qualityTargetForAu(binding,index,au,counts);if(value.target)targets.push(value.target);else unsupported.push({au,sourcePtsUs:p.pts,reason:value.reason??'unsupported AU'});
  }
  if(!targets.length)throw new CambiError('unsupported-source','No selected AU has a supported exact identity window');
  if(targets.length>CAMBI_LIMITS.frames)throw new CambiError('budget-exceeded','Selected frames exceed32');
  const pts=targets.map(t=>t.sourcePtsUs).sort((a,b)=>a-b);if(pts.some((p,i)=>p<0||i>1&&p-pts[i-1]!==pts[1]-pts[0]))throw new CambiError('unsupported-source','Negative/VFR selected source clocks not admitted');
  const result:CambiPrepared={frames:[],geometry:{width:0,height:0,bitDepth:8},coverage:{scope:'bounded-source-pts-interval',interval:data.input.interval,sampling:data.input.sampling,intervalAus:rows.length,selected:targets.length,unsampled,unsupported,scored:0,unscored:targets.length,tracking:'none'},output:null!,rawBytes:0,work:{readBytes:0,packets:0,outputFrames:0,indexBytes:0,indexPackets:0,heapBytes:0,elapsedMs:0}};
  let core:Awaited<ReturnType<typeof instantiateCore>>|undefined;
  const load=async()=>{check();if(!core){const glue=await import(pathToFileURL(path.join(data.coreDir,'voidplayer-core.js')).href);core=await instantiateCore(glue.default,new Uint8Array(readFileSync(path.join(data.coreDir,'voidplayer-core.wasm'))),256*1024*1024);}return core;};
  for(const [ordinal,target]of targets.entries()){
   check();const source=open(target);try{
    const picture=await inspectFlvFrame(target,source.source,()=>createPairDecoder(load),new AbortController().signal);check();
    const f=picture.frame,d=f.description;validateDescription(d,f.pixels.length);
    const c=d.sourceColor??d.color,l=d.yuv;
    if(d.format!=='YUV'||!l||![8,10].includes(l.bitDepth)||[c.primaries,c.transfer,c.matrix].some(t=>t!=='bt709')||c.fullRange!==false||l.chromaLocation!==1||d.displayWidth!==d.width||d.displayHeight!==d.height)throw new CambiError('unsupported-source','CAMBI requires explicit limited BT709 SDR YUV420 8/10bit left chroma and square full-frame geometry');
    const geometry={width:d.width,height:d.height,bitDepth:l.bitDepth as 8|10};if(ordinal&&JSON.stringify(geometry)!==JSON.stringify(result.geometry))throw new CambiError('source-changed','CAMBI geometry changed');result.geometry=geometry;result.output=cambiOutputBudget(d.width,d.height,targets.length,data.input);
    result.work.readBytes+=picture.work.readBytes;result.work.packets+=picture.work.packets;result.work.outputFrames+=picture.work.outputFrames;
    if(result.work.readBytes>CAMBI_LIMITS.maxReadBytes||result.work.packets>CAMBI_LIMITS.maxPackets||result.work.outputFrames>CAMBI_LIMITS.maxPackets)throw new CambiError('budget-exceeded','CAMBI cumulative dependency work budget');
    const hash=createHash('sha256');Atomics.add(control,1,1);let fd:number|undefined;
    try{check();fd=openSync(path.join(data.directory,'source.yuv'),'a',0o600);for(const [pi,plane]of l.planes.entries())for(let y=0;y<(pi?d.height/2:d.height);y++){
     check();const width=(pi?d.width/2:d.width)*(l.bitDepth===8?1:2),line=f.pixels.subarray(plane.offset+y*plane.stride,plane.offset+y*plane.stride+width);
     if(result.rawBytes+line.length>data.input.budget.maxRawBytes)throw new CambiError('budget-exceeded','CAMBI raw bytes budget');let n=0;while(n<line.length){const wrote=writeSync(fd,line,n,line.length-n);if(!wrote)throw new CambiError('source-io-failed','CAMBI short write');n+=wrote;}hash.update(line);result.rawBytes+=line.length;
    }}finally{if(fd!==undefined)closeSync(fd);Atomics.sub(control,1,1);Atomics.notify(control,1);}
    result.frames.push({index:ordinal,target,provenance:picture.provenance,decoder:picture.decoder,context:source.annotationContext,proof:source.proof,rawSha256:hash.digest('hex'),score:null,heatmaps:[]});result.work.heapBytes=Math.max(result.work.heapBytes,core!.heap().byteLength);progress(ordinal+1,targets.length);
   }finally{source.source.close();}
  }
  const final=open(targets.at(-1)!);final.source.close();check();result.work.indexBytes=indexBytes;result.work.indexPackets=indexPackets;result.work.elapsedMs=Math.ceil(performance.now()-started);return result;
 }finally{db.close();}
}
