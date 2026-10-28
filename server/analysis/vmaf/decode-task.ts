import {readFileSync,openSync,writeSync,closeSync} from 'node:fs';
import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {openIndexDatabase} from '../../sqlite.ts';import {FrameIndexStore} from '../../frame-index-store.ts';
import {libraryPairSource} from '../quality/file-source.ts';
import {qualitySourceIndex,qualityIndexPacketCount} from '../../../shared/analysis/quality/source-index.ts';
import {avcGeometry} from '../../../shared/media/codecs/avc-geometry.ts';import {hevcGeometry} from '../../../shared/media/codecs/hevc-geometry.ts';
import {inspectFramePair,pairBudget,requireInspectionGeometry} from '../../../shared/analysis/quality/frame-pair.ts';
import {createPairDecoder} from '../../../shared/analysis/quality/wasm-decoder.ts';import {instantiateCore} from '../../../shared/wasm/core.ts';
import {measurePsnr} from '../../../shared/analysis/quality/psnr.ts';import {measureSsim,SSIM_VARIANT} from '../../../shared/analysis/quality/ssim.ts';
import {vmafSequence,VMAF_LIMITS,VmafError} from '../../../shared/analysis/quality/vmaf.ts';
import type {VmafInput,VmafPlanSnapshot,VmafPrepared} from '../../../shared/analysis/quality/vmaf.ts';
import type {PsnrFrame} from '../../../shared/analysis/quality/psnr.ts';
export type VmafDecodeData={mode:'preflight'|'decode'|'verify';database:string;coreDir:string;directory:string;input:Pick<VmafInput,'cadenceUs'|'metrics'|'budget'>;snapshot:VmafPlanSnapshot;control:SharedArrayBuffer};

export async function runVmafDecode(data:VmafDecodeData,progress:(frames:number,total:number)=>void){
 let decodeDeadline=data.input.budget.maxElapsedMs;
 const started=performance.now(),control=new Int32Array(data.control),controller=new AbortController();
 const check=()=>{if(Atomics.load(control,0))throw new VmafError('cancelled','Sequence decode cancelled');if(performance.now()-started>decodeDeadline)throw new VmafError('budget-exceeded','Sequence decode deadline exceeded');};
 const db=openIndexDatabase(data.database,{readOnly:true}),store=new FrameIndexStore(db);
 let indexBytes=0,indexPackets=0;
 const budgetFor=(request:Parameters<typeof pairBudget>[0])=>({...pairBudget(request),maxIndexBytes:Math.max(1,Math.min(pairBudget(request).maxIndexBytes,VMAF_LIMITS.maxIndexBytes-indexBytes)),maxIndexPackets:Math.max(1,Math.min(pairBudget(request).maxIndexPackets,VMAF_LIMITS.maxIndexPackets-indexPackets))});
 const openPair=(request:Parameters<typeof pairBudget>[0])=>{
  const sources:ReturnType<typeof libraryPairSource>[]=[];
  try{for(const target of [request.reference,request.distorted]){check();const value=libraryPairSource(db,store,target,budgetFor(request),control);sources.push(value);if(!value.source.index)throw new VmafError('unsupported-vmaf-sequence','Native VMAF requires an existing complete trusted source index');indexBytes+=Buffer.byteLength(JSON.stringify(value.source.index));indexPackets+=qualityIndexPacketCount(value.source.index);
   if(indexBytes>VMAF_LIMITS.maxIndexBytes||indexPackets>VMAF_LIMITS.maxIndexPackets)throw new VmafError('budget-exceeded','Cumulative index read budget exceeded');}return sources as [typeof sources[number],typeof sources[number]];
  }catch(error){for(const s of sources)s.source.close();throw error;}
 };
 try{
  const original=data.snapshot.value.rangePlan;if(!original)throw new VmafError('unsupported-vmaf-sequence','No executable frozen C plan');decodeDeadline=Math.min(decodeDeadline,original.input.budget.maxElapsedMs);
  const initial=openPair(original.input.pairs[0]);
  let sequence;
  try{const indexes=initial.map(s=>qualitySourceIndex(s.source.index!,s.source.binding().size)) as [ReturnType<typeof qualitySourceIndex>,ReturnType<typeof qualitySourceIndex>];
   sequence=vmafSequence(data.snapshot,indexes,data.input.cadenceUs);
   const geometry=indexes.map(index=>{const g=index.codec==='h264'?avcGeometry(index.description,true):index.codec==='hevc'?hevcGeometry(index.description,true):null;if(!g)throw new VmafError('unsupported-vmaf-sequence','Unsupported quality source codec');requireInspectionGeometry(g);return g;});
   if(geometry.some(g=>g.width<VMAF_LIMITS.minDimension||g.height<VMAF_LIMITS.minDimension||g.width>VMAF_LIMITS.width||g.height>VMAF_LIMITS.height)||geometry[0].width!==geometry[1].width||geometry[0].height!==geometry[1].height)throw new VmafError('unsupported-vmaf-sequence','Equal supported full-frame geometry required');
   for(const pair of sequence.pairs)if(pair.roi.x||pair.roi.y||pair.roi.width!==geometry[0].width||pair.roi.height!==geometry[0].height)throw new VmafError('unsupported-vmaf-sequence','Arbitrary ROI is unsupported; pin the entire visible frame in C');
  }finally{initial.forEach(s=>s.source.close());}
  if(data.mode!=='decode')return {sequence,indexBytes,indexPackets,elapsedMs:performance.now()-started};
  let loaded:Awaited<ReturnType<typeof instantiateCore>>|undefined;
  const load=async()=>{check();if(!loaded){const binary=readFileSync(path.join(data.coreDir,'voidplayer-core.wasm'));const glue=await import(pathToFileURL(path.join(data.coreDir,'voidplayer-core.js')).href);loaded=await instantiateCore(glue.default,new Uint8Array(binary),256*1024*1024);}check();return loaded;};
  const result:VmafPrepared={sequence,geometry:{width:0,height:0,bitDepth:8},pairs:[],raw:{referenceSha256:'',distortedSha256:'',bytes:0},work:{readBytes:0,packets:0,outputFrames:0,indexBytes:0,indexPackets:0,inputBytes:0,heapBytes:0,elapsedMs:0}};
  const hashes=[createHash('sha256'),createHash('sha256')];
  const writeFrame=(role:0|1,frame:PsnrFrame)=>{
   const d=frame.description,layout=d.yuv!;
   const amount=d.width*d.height*3/2*(layout.bitDepth===8?1:2);
   if(result.raw.bytes+amount>data.input.budget.maxRawBytes)throw new VmafError('budget-exceeded','Raw temporary disk budget exceeded');
   check();Atomics.add(control,1,1);let fd:number|undefined;
   try{check();fd=openSync(path.join(data.directory,role?'distorted.yuv':'reference.yuv'),'a',0o600);
    for(const [planeIndex,plane]of layout.planes.entries())for(let y=0;y<(planeIndex?d.height/2:d.height);y++){
     check();const width=(planeIndex?d.width/2:d.width)*(layout.bitDepth===8?1:2),line=frame.pixels.subarray(plane.offset+y*plane.stride,plane.offset+y*plane.stride+width);let n=0;
     while(n<line.length){check();const written=writeSync(fd,line,n,line.length-n);if(!written)throw new VmafError('source-io-failed','Raw sequence short write');n+=written;}hashes[role].update(line);result.raw.bytes+=line.length;
    }
   }finally{if(fd!==undefined)closeSync(fd);Atomics.sub(control,1,1);Atomics.notify(control,1);}
  };
  for(const [ordinal,request]of sequence.pairs.entries()){
   check();const opened=openPair(request);
   try{
    const pair=await inspectFramePair(request,[opened[0].source,opened[1].source],()=>createPairDecoder(load),controller.signal);check();
    const [reference,distorted]=pair.frames;
    const metric=measurePsnr({domain:'source-yuv-code-values',reference,distorted,roi:request.roi,spatial:request.spatial,budget:{maxInputBytes:request.budget?.maxInputBytes,maxSamples:request.budget?.maxSamples}});
    const ssim=data.input.metrics.ssim?measureSsim({domain:'source-yuv-code-values',reference,distorted,roi:request.roi,spatial:request.spatial},{variant:SSIM_VARIANT}):undefined;
    const d=reference.description;
    if([metric.color.primaries,metric.color.transfer,metric.color.matrix].some(c=>c!=='bt709')||metric.color.fullRange||metric.color.chromaLocation!==1||d.displayWidth!==d.width||d.displayHeight!==d.height)throw new VmafError('unsupported-vmaf-sequence','Limited BT.709 SDR with left chroma and exact square full-frame geometry required; no conversion');
    const geometry={width:d.width,height:d.height,bitDepth:metric.bitDepth};if(ordinal&&JSON.stringify(result.geometry)!==JSON.stringify(geometry))throw new VmafError('unsupported-vmaf-sequence','Sequence geometry/bit-depth changed');result.geometry=geometry;
    result.work.readBytes+=pair.work.readBytes;result.work.packets+=pair.work.packets;result.work.outputFrames+=pair.work.outputFrames;result.work.inputBytes+=metric.work.chargedInputBytes;
    const total=original.input.budget;
    if(result.work.readBytes>total.maxReadBytes||result.work.packets>total.maxPackets||result.work.outputFrames>total.maxOutputFrames||result.work.inputBytes>total.maxInputBytes)throw new VmafError('budget-exceeded','Cumulative sequence pre/post-roll/drain/input budget exceeded');
    writeFrame(0,reference);writeFrame(1,distorted);
    result.pairs.push({schema:'voidplayer-library-frame-pair-psnr',version:opened.some(s=>s.proof.binding.indexIdentity.kind==='mp4')?2:1,execution:{host:'node-worker',runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun??process.versions.node,sourceIdentity:'stat-version-v1'},
     result:{schema:'voidplayer-frame-pair-psnr',version:1,pairing:'caller-specified',correspondence:'caller-specified-no-content-or-time-alignment',decoder:pair.decoder,metric,...(ssim?{ssim}:{}),provenance:pair.provenance,work:pair.work},annotationContext:{reference:opened[0].annotationContext,distorted:opened[1].annotationContext},sources:{reference:opened[0].proof,distorted:opened[1].proof}});
    result.work.heapBytes=Math.max(result.work.heapBytes,loaded!.heap().byteLength);progress(ordinal+1,sequence.pairs.length);
   }finally{opened.forEach(s=>s.source.close());}
  }
  // Validate current bindings again after the complete decode, before publishing companions.
  const last=openPair(sequence.pairs.at(-1)!);last.forEach(s=>s.source.close());check();
  result.raw.referenceSha256=hashes[0].digest('hex');result.raw.distortedSha256=hashes[1].digest('hex');result.work.indexBytes=indexBytes;result.work.indexPackets=indexPackets;result.work.elapsedMs=Math.ceil(performance.now()-started);
  if(Buffer.byteLength(JSON.stringify(result))>VMAF_LIMITS.resultBytes)throw new VmafError('budget-exceeded','Prepared sequence result exceeds limit');
  return result;
 }finally{db.close();}
}
