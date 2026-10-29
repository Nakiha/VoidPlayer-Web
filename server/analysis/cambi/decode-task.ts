import {clockDeltaEquals} from '../../../shared/media/indexing/rational-clock.ts';
import {qualitySourceClock} from '../../../shared/analysis/quality/source-index.ts';
import type {PsnrFrame} from '../../../shared/analysis/quality/psnr.ts';
import type {QualityExecutionContract,ExecutionEnvironment} from '../../../shared/analysis/quality/reexecution.ts';
import {executionEnvironment,requireExecutionContract} from '../quality/execution-contract.ts';
import {avcGeometry} from '../../../shared/media/codecs/avc-geometry.ts';import {hevcGeometry} from '../../../shared/media/codecs/hevc-geometry.ts';
import {readFileSync,openSync,writeSync,closeSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {openIndexDatabase} from '../../sqlite.ts';import {FrameIndexStore} from '../../frame-index-store.ts';import {libraryPairSource} from '../quality/file-source.ts';
import {qualitySourceIndex,qualityIndexPacketCount} from '../../../shared/analysis/quality/source-index.ts';import {qualityTargetForAu} from '../../../shared/analysis/quality/selection.ts';
import {inspectSourceFrame,inspectSourceSequence,PAIR_LIMITS,requireInspectionGeometry} from '../../../shared/analysis/quality/frame-pair.ts';import type {PairTarget} from '../../../shared/analysis/quality/frame-pair.ts';
import {createPairDecoder} from '../../../shared/analysis/quality/wasm-decoder.ts';import {instantiateCore} from '../../../shared/wasm/core.ts';import {validateDescription} from '../../../shared/media/frame-description.ts';
import {CAMBI_LIMITS,CAMBI_RECIPE,CambiError,cambiOutputBudget,cambiIntervalClocks} from '../../../shared/analysis/quality/cambi.ts';import type {CambiInput,CambiPrepared} from '../../../shared/analysis/quality/cambi.ts';
export async function runCambiDecode(data:{mode:'preflight'|'decode'|'verify'|'picture';target?:PairTarget;database:string;coreDir:string;directory:string;input:CambiInput;control:SharedArrayBuffer;remainingIndex?:{maxIndexBytes:number;maxIndexPackets:number};analysisContract?:QualityExecutionContract['analysis'];nativeCambiContract?:Omit<NonNullable<QualityExecutionContract['nativeCambi']>,'selection'>;expectedExecutionContract?:QualityExecutionContract},progress:(frames:number,total:number)=>void,onContract?:(c:QualityExecutionContract)=>void,onWitness?:(e:ExecutionEnvironment)=>void,onFrame?:(frame:PsnrFrame,prepared:CambiPrepared,index:number,total:number)=>Promise<void>){
 const started=performance.now(),control=new Int32Array(data.control),check=()=>{if(Atomics.load(control,0))throw new CambiError('cancelled','CAMBI decode cancelled');if(performance.now()-started>data.input.budget.maxElapsedMs)throw new CambiError('budget-exceeded','CAMBI decode deadline');};
 const db=openIndexDatabase(data.database,{readOnly:true}),store=new FrameIndexStore(db);let indexBytes=0,indexPackets=0;const maxIndexBytes=Math.min(CAMBI_LIMITS.maxIndexBytes,data.remainingIndex?.maxIndexBytes??CAMBI_LIMITS.maxIndexBytes),maxIndexPackets=Math.min(CAMBI_LIMITS.maxIndexPackets,data.remainingIndex?.maxIndexPackets??CAMBI_LIMITS.maxIndexPackets);
 const open=(t:PairTarget)=>{check();const v=libraryPairSource(db,store,t,{...PAIR_LIMITS,maxIndexBytes:Math.min(PAIR_LIMITS.maxIndexBytes,maxIndexBytes-indexBytes),maxIndexPackets:Math.min(PAIR_LIMITS.maxIndexPackets,maxIndexPackets-indexPackets)},control);if(!v.source.index){v.source.close();throw new CambiError('unsupported-source','Native CAMBI requires an existing trusted quality index');}indexBytes+=Buffer.byteLength(JSON.stringify(v.source.index));indexPackets+=qualityIndexPacketCount(v.source.index);if(indexBytes>maxIndexBytes||indexPackets>maxIndexPackets){v.source.close();throw new CambiError('budget-exceeded','Cumulative CAMBI index budget');}return v;};
 const dummy={...data.input.source,sourcePtsUs:0,picture:{sourceVersion:`${data.input.source.mediaId}@${data.input.source.mediaVersion}`,stream:'video',configuration:0,au:0,picture:0,layer:0,field:'frame'}} as PairTarget;
 try{
  const first=open(dummy);let index,binding;try{index=qualitySourceIndex(first.source.index!,data.input.source.size);binding=first.proof;}finally{first.source.close();}
  const {startPtsUs,endPtsUs}=data.input.interval,rows=index.packets.flatMap((p,au)=>p.pts>=startPtsUs&&p.pts<endPtsUs?[{au,p}]:[]);
  if(!rows.length)throw new CambiError('no-results','No indexed pictures in the declared interval');
  if(rows.length>CAMBI_LIMITS.intervalAus)throw new CambiError('budget-exceeded',`Interval exceeds ${CAMBI_LIMITS.intervalAus} indexed AUs`);
  if(index.mp4){
   const ordered=[...rows].sort((a,b)=>a.p.pts-b.p.pts),duration=index.mp4.samples[ordered[0].au].durationTicks;
   if(ordered.some((r,i)=>index.mp4!.samples[r.au].durationTicks!==duration||i>0&&!clockDeltaEquals(qualitySourceClock(index,r.au),qualitySourceClock(index,ordered[i-1].au),{ticks:duration,timescale:index.mp4!.timescale})))throw new CambiError('unsupported-source','MP4 interval requires exact continuous sample ticks');
  }else cambiIntervalClocks(rows.map(r=>r.p.pts));
  const counts=new Map<number,number>();for(const p of index.packets)counts.set(p.pts,(counts.get(p.pts)??0)+1);
  const targets:PairTarget[]=[],unsupported:CambiPrepared['coverage']['unsupported']=[];let unsampled=0;
  for(const [ordinal,{au,p}]of rows.entries()){
   if(ordinal%data.input.sampling.stride){unsampled++;continue;}
   const value=qualityTargetForAu(binding,index,au,counts);if(value.target)targets.push(value.target);else unsupported.push({au,sourcePtsUs:p.pts,reason:value.reason??'unsupported AU'});
  }
  if(index.mp4)targets.sort((a,b)=>a.sourcePtsUs-b.sourcePtsUs);
  if(data.mode==='picture'){if(!data.target)throw Error('Missing picture target');targets.splice(0,targets.length,data.target);}
  if(!targets.length)throw new CambiError('unsupported-source','No selected AU has a supported exact identity window');
  if(targets.length>CAMBI_LIMITS.frames)throw new CambiError('budget-exceeded',`Selected frames exceed ${CAMBI_LIMITS.frames}`);
  const pts=targets.map(t=>t.sourcePtsUs).sort((a,b)=>a-b);if(pts.some((p,i)=>p<0||!index.mp4&&i>1&&p-pts[i-1]!==pts[1]-pts[0]))throw new CambiError('unsupported-source','Negative/VFR selected source clocks not admitted');
  let contract:QualityExecutionContract|undefined;
  const witness={passes:0,assetBytes:0,producerBytes:0};
  const readEnvironment=()=>{const e=executionEnvironment(data.coreDir,control,check);witness.passes++;witness.assetBytes+=e.assets.reduce((n,a)=>n+a.bytes,0);witness.producerBytes+=e.producerBuild.bytes;onWitness?.(e);return e;};
  if(data.mode!=='picture'){
   const geometry=index.codec==='h264'?avcGeometry(index.description,true):hevcGeometry(index.description,true);if(!geometry)throw new CambiError('unsupported-source','Explicit source geometry is required');requireInspectionGeometry(geometry);cambiOutputBudget(geometry.width,geometry.height,targets.length,data.input);
   if(!data.nativeCambiContract&&!data.analysisContract)throw new CambiError('execution-contract-unavailable','CAMBI native execution witness is missing');
   const selection:NonNullable<QualityExecutionContract['nativeCambi']>['selection']={pictures:targets.map(t=>({au:t.picture.au,configuration:t.picture.configuration,sourcePtsUs:t.sourcePtsUs,...(t.decode?{decode:t.decode}:{})})),geometry:{width:geometry.width,height:geometry.height},frameOrder:index.mp4?'source-pts-after-decode-au-selection':'decode-au-selection',intervalAus:rows.length,unsampled,unsupported:unsupported.length,unsupportedSha256:createHash('sha256').update(JSON.stringify(unsupported)).digest('hex')};
   const {pictures,...selectionHeader}=selection;const compact=data.analysisContract&&pictures.length>32?{...selectionHeader,schema:'voidplayer-cambi-selection' as const,version:1 as const,selectedPictures:pictures.length,picturesSha256:createHash('sha256').update(JSON.stringify(pictures)).digest('hex'),firstPicture:pictures[0],lastPicture:pictures.at(-1)!,dependencyInputs:[...new Map(pictures.map(p=>[p.decode?`${p.decode.startAu}:${p.decode.mode==='packet-identity-gop-v1'?p.decode.endAu:p.au}`:`${p.au}`,p.decode?(p.decode.mode==='packet-identity-gop-v1'?p.decode.endAu:p.au)-p.decode.startAu+1:1])).values()].reduce((a,b)=>a+b,0)}:selection;
   contract={schema:'voidplayer-quality-execution-contract',version:1,environment:readEnvironment(),sources:[binding],...(data.analysisContract?{analysis:{...data.analysisContract,selection:compact}}:{nativeCambi:{...data.nativeCambiContract!,selection}})};
   requireExecutionContract(data.expectedExecutionContract,contract);if(data.mode==='decode')onContract?.(contract);
   if(data.mode!=='decode')return {indexBytes,indexPackets,contract,witness};
  }
  const result:CambiPrepared={...(index.mp4?{frameOrder:'source-pts-after-decode-au-selection' as const}:{}),frames:[],geometry:{width:0,height:0,bitDepth:8},coverage:{scope:'bounded-source-pts-interval',interval:data.input.interval,sampling:data.input.sampling,intervalAus:rows.length,selected:targets.length,unsampled,unsupported,scored:0,unscored:targets.length,tracking:'none'},output:null!,rawBytes:0,work:{readBytes:0,packets:0,outputFrames:0,indexBytes:0,indexPackets:0,heapBytes:0,elapsedMs:0}};
  let core:Awaited<ReturnType<typeof instantiateCore>>|undefined;
  const load=async()=>{check();if(!core){if(contract)requireExecutionContract(contract,{...contract,environment:readEnvironment()});const glue=await import(pathToFileURL(path.join(data.coreDir,'voidplayer-core.js')).href);core=await instantiateCore(glue.default,new Uint8Array(readFileSync(path.join(data.coreDir,'voidplayer-core.wasm'))),256*1024*1024);}return core;};
  async function* pictures(){
   if(data.mode!=='picture'&&targets.every(t=>t.decode?.mode==='packet-identity-gop-v1')){
    const source=open(targets[0]);try{let ordinal=0;for await(const picture of inspectSourceSequence(targets,source.source,()=>createPairDecoder(load),new AbortController().signal))yield {ordinal,target:targets[ordinal++],picture,source};}finally{source.source.close();}
   }else for(const [ordinal,target]of targets.entries()){const source=open(target);try{yield {ordinal,target,source,picture:await inspectSourceFrame(target,source.source,()=>createPairDecoder(load),new AbortController().signal)};}finally{source.source.close();}}
  }
  for await(const {ordinal,target,picture,source}of pictures()){
    check();
    const f=picture.frame,d=f.description;validateDescription(d,f.pixels.length);
    const c=d.sourceColor??d.color,l=d.yuv;
    if(d.format!=='YUV'||!l||l.semiplanar||l.subsampleX!==1||l.subsampleY!==1||l.bitShift!==0||d.colorFallback||![8,10].includes(l.bitDepth)||[c.primaries,c.transfer,c.matrix].some(t=>t!=='bt709')||c.fullRange!==false||l.chromaLocation!==1||d.displayWidth!==d.width||d.displayHeight!==d.height)throw new CambiError('unsupported-source',`CAMBI requires explicit limited BT709 SDR YUV420 8/10bit left chroma and square full-frame geometry: ${JSON.stringify({color:c,bitDepth:l?.bitDepth,chromaLocation:l?.chromaLocation,width:d.width,displayWidth:d.displayWidth,height:d.height,displayHeight:d.displayHeight,format:d.format})}`);
    if(data.mode==='picture')return {frame:{description:d,pixels:f.pixels},provenance:picture.provenance,decoder:picture.decoder,work:picture.work};
    const geometry={width:d.width,height:d.height,bitDepth:l.bitDepth as 8|10};if(ordinal&&JSON.stringify(geometry)!==JSON.stringify(result.geometry))throw new CambiError('source-changed','CAMBI geometry changed');result.geometry=geometry;result.output=cambiOutputBudget(d.width,d.height,targets.length,data.input);
    result.work.readBytes+=picture.work.readBytes;result.work.packets+=picture.work.packets;result.work.outputFrames+=picture.work.outputFrames;
    if(result.work.readBytes>CAMBI_LIMITS.maxReadBytes||result.work.packets>CAMBI_LIMITS.maxPackets||result.work.outputFrames>CAMBI_LIMITS.maxPackets)throw new CambiError('budget-exceeded','CAMBI cumulative dependency work budget');
    const hash=createHash('sha256');Atomics.add(control,1,1);let fd:number|undefined;
    try{check();if(!onFrame)fd=openSync(path.join(data.directory,'source.yuv'),'a',0o600);for(const [pi,plane]of l.planes.entries())for(let y=0;y<(pi?d.height/2:d.height);y++){
     check();const width=(pi?d.width/2:d.width)*(l.bitDepth===8?1:2),line=f.pixels.subarray(plane.offset+y*plane.stride,plane.offset+y*plane.stride+width);
     if(result.rawBytes+line.length>data.input.budget.maxRawBytes)throw new CambiError('budget-exceeded','CAMBI raw bytes budget');let n=0;while(fd!==undefined&&n<line.length){const wrote=writeSync(fd,line,n,line.length-n);if(!wrote)throw new CambiError('source-io-failed','CAMBI short write');n+=wrote;}hash.update(line);result.rawBytes+=line.length;
    }}finally{if(fd!==undefined)closeSync(fd);Atomics.sub(control,1,1);Atomics.notify(control,1);}
    result.frames.push({index:ordinal,target,provenance:picture.provenance,sourceGeometry:picture.sourceGeometry,decoder:picture.decoder,context:source.annotationContext,proof:source.proof,rawSha256:hash.digest('hex'),score:null,heatmaps:[]});result.work.heapBytes=Math.max(result.work.heapBytes,core!.heap().byteLength);progress(ordinal+1,targets.length);await onFrame?.(f,result,ordinal,targets.length);
  }
  const final=open(targets.at(-1)!);final.source.close();check();result.work.indexBytes=indexBytes;result.work.indexPackets=indexPackets;result.work.elapsedMs=Math.ceil(performance.now()-started);result.work.executionWitness=witness;return result;
 }finally{db.close();}
}
