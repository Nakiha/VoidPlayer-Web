import {mkdirSync,rmSync,writeFileSync,readFileSync,readdirSync,lstatSync,openSync,readSync,closeSync} from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {NativeVmafRunner} from '../vmaf/runner.ts';import type {VmafComponent} from '../vmaf/component.ts';
import {CAMBI_LIMITS,CAMBI_RECIPE,CAMBI_CAPABILITY,CambiError,cambiOutputBudget} from '../../../shared/analysis/quality/cambi.ts';import type {CambiInput,CambiPrepared,CambiNative} from '../../../shared/analysis/quality/cambi.ts';
import type {VmafComponentConfig} from '../../../shared/analysis/quality/vmaf.ts';import type {MediaLibraryIndex} from '../../library.ts';
export type CambiHooks={admitted():void;phase(name:string):void;progress(n:number,total:number):void;prepared(p:CambiPrepared):void;process(p:{pid:number;startTicks:string;bootId:string}|null):void;frame(index:number,score:number,maps:{scale:number;bytes:Uint8Array;sha256:string}[]):void|Promise<void>};
export class NativeCambiRunner extends NativeVmafRunner{
 constructor(library:MediaLibraryIndex,coreDir:string,config:VmafComponentConfig|undefined){super(library,coreDir,config);}
 async cambiCapability(){
  const basic={...CAMBI_CAPABILITY,configured:!!this.config,enabled:false,reason:'component-unavailable'};
  if(!this.config||process.platform!=='linux'||process.arch!=='x64')return basic;
  try{return await this.owned({budget:{maxElapsedMs:30000}},new AbortController().signal,()=>{},async signal=>{
   const c=await this.component('vmaf_v0_6_1',signal),directory=this.directory('selftest-'+randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
   try{const input={budget:{...CAMBI_LIMITS}} as unknown as CambiInput;input.budget.maxHeatBytes=CAMBI_LIMITS.maxHeatBytes;const output=cambiOutputBudget(320,64,1,input);writeFileSync(path.join(directory,'source.yuv'),Buffer.concat([Buffer.alloc(320*64,80),Buffer.alloc(320*64/2,128)]));
    await this.nativeCambi(c,directory,input,{geometry:{width:320,height:64,bitDepth:8},frames:[{index:0}],output} as CambiPrepared,signal,()=>{});
    return {...basic,enabled:true,reason:null,component:{manifestSha256:c.manifestSha256,sourceRevision:c.sourceRevision,cliVersion:c.cliVersion},selfTest:'executed-CAMBI-and-five-heatmaps'};
   }finally{if(!this.stopUncertain)rmSync(directory,{recursive:true,force:true});}
  });}catch(error){const code=(error as {code?:string}).code??'execution-failed';return {...basic,reason:['quality-busy','component-unavailable'].includes(code)?code:'cambi-feature-unavailable',selfTestFailure:code};}
 }
 directory(id:string){if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw new CambiError('invalid-request','Invalid temporary job ID');return path.join(this.library.indexDatabase+'.cambi-tmp',id);}
 async runCambi(id:string,input:CambiInput,signal:AbortSignal,hooks:CambiHooks){return this.owned(input,signal,hooks.admitted,async combined=>{
  const directory=this.directory(id);let temporary=false;
  try{
   hooks.phase('component');const c=await this.component('vmaf_v0_6_1',combined);combined.throwIfAborted();mkdirSync(directory,{recursive:true,mode:0o700});temporary=true;
   hooks.phase('decode');const prepared=await this.worker<CambiPrepared>('../cambi/decode-worker.ts',{mode:'decode',database:this.library.indexDatabase,coreDir:this.coreDir,directory,input},combined,hooks.progress);combined.throwIfAborted();hooks.prepared(prepared);
   hooks.phase('native');const native=await this.nativeCambi(c,directory,input,prepared,combined,hooks.process);combined.throwIfAborted();
   // Validate binding again after native completion and before immutable publication.
   hooks.phase('source-final');const final=await this.worker<{indexBytes:number;indexPackets:number}>('../cambi/decode-worker.ts',{mode:'verify',database:this.library.indexDatabase,coreDir:this.coreDir,directory,input},combined);combined.throwIfAborted();
   if(final.indexBytes+prepared.work.indexBytes>CAMBI_LIMITS.maxIndexBytes||final.indexPackets+prepared.work.indexPackets>CAMBI_LIMITS.maxIndexPackets)throw new CambiError('budget-exceeded','CAMBI cumulative final index budget');
   hooks.phase('persist-evidence');for(const frame of prepared.frames){combined.throwIfAborted();const maps=[];for(const scale of prepared.output.scales){
    const bytes=Buffer.alloc(scale.bytes),fd=openSync(path.join(directory,'heat',scale.file),'r');try{let filled=0;while(filled<bytes.length){const n=readSync(fd,bytes,filled,bytes.length-filled,frame.index*scale.bytes+filled);if(!n)throw new CambiError('native-result-invalid','Truncated CAMBI heatmap');filled+=n;}}finally{closeSync(fd);}
    maps.push({scale:scale.scale,bytes,sha256:createHash('sha256').update(bytes).digest('hex')});
   }await hooks.frame(frame.index,native.frames[frame.index].score,maps);}
   return {prepared,native};
  }finally{if(temporary&&!this.stopUncertain)try{rmSync(directory,{recursive:true,force:true});}catch{this.stopUncertain=true;throw new CambiError('stop-uncertain','CAMBI temporary evidence could not be reclaimed');}}
 });}
 async inspectCambi(input:CambiInput,target:import('../../../shared/analysis/quality/frame-pair.ts').PairTarget,signal:AbortSignal){return this.owned(input,signal,()=>{},s=>this.worker<{frame:import('../../../shared/analysis/quality/psnr.ts').PsnrFrame;provenance:import('../../../shared/analysis/quality/frame-pair.ts').PairProvenance;decoder:import('../../../shared/analysis/quality/frame-pair.ts').PairDecoder['version'];work:unknown}>('../cambi/decode-worker.ts',{mode:'picture',database:this.library.indexDatabase,coreDir:this.coreDir,directory:'',input,target},s));}
 private async nativeCambi(c:VmafComponent,directory:string,input:CambiInput,prepared:CambiPrepared,signal:AbortSignal,onProcess:CambiHooks['process']):Promise<CambiNative>{
  mkdirSync(path.join(directory,'heat'),{mode:0o700});const count=prepared.frames.length,g=prepared.geometry,expected=g.width*g.height*3/2*(g.bitDepth===8?1:2)*count;
  if(lstatSync(path.join(directory,'source.yuv')).size!==expected)throw new CambiError('native-result-invalid','CAMBI raw frame length differs');
  const args=[String(input.budget.nativeCpuSeconds),String(input.budget.nativeMemoryBytes),String(prepared.output.fileCap),c.binary,'--reference','source.yuv','--distorted','source.yuv','--width',String(g.width),'--height',String(g.height),'--pixel_format','420','--bitdepth',String(g.bitDepth),'--no_prediction','--feature','cambi=window_size=63:topk=0.6:tvi_threshold=0.019:max_log_contrast=2:eotf=bt1886:full_ref=false:heatmaps_path=heat','--threads','1','--cpumask','0','--json','--output','result.json','--quiet'];
  const resources=await this.executeNative(c,directory,args,signal,onProcess);signal.throwIfAborted();
  const names=readdirSync(path.join(directory,'heat')).sort(),expectedNames=prepared.output.scales.map(s=>s.file).sort();
  if(JSON.stringify(names)!==JSON.stringify(expectedNames))throw new CambiError('native-result-invalid','Expected exactly five official CAMBI scale files');
  let outputBytes=0;for(const scale of prepared.output.scales){const s=lstatSync(path.join(directory,'heat',scale.file));if(!s.isFile()||s.size!==scale.bytes*count)throw new CambiError('native-result-invalid','CAMBI heatmap layout/length differs');outputBytes+=s.size;}
  const resultStat=lstatSync(path.join(directory,'result.json'));if(!resultStat.isFile()||resultStat.size>CAMBI_LIMITS.resultBytes||outputBytes!==prepared.output.heatBytes||outputBytes>input.budget.maxHeatBytes||outputBytes+resultStat.size>prepared.output.reservedOutputBytes)throw new CambiError('budget-exceeded','CAMBI aggregate heatmap/result bytes exceeded');
  const v=JSON.parse(readFileSync(path.join(directory,'result.json'),'utf8'));
  if(v.version!==c.cliVersion||!Array.isArray(v.frames)||v.frames.length!==count||v.frames.some((f:any,i:number)=>f.frameNum!==i||Object.keys(f.metrics??{}).join(',')!=='cambi'||!Number.isFinite(f.metrics.cambi)||f.metrics.cambi<0))throw new CambiError('native-result-invalid','No complete ordered official CAMBI scores');
  const pooled=v.pooled_metrics?.cambi;if(!pooled||['min','max','mean','harmonic_mean'].some(k=>!Number.isFinite(pooled[k])||pooled[k]<0))throw new CambiError('native-result-invalid','No official CAMBI pool');
  return {version:v.version,recipe:CAMBI_RECIPE,component:{manifestSha256:c.manifestSha256,binarySha256:c.binarySha256,supervisorSha256:c.supervisorSha256,sourceRevision:c.sourceRevision},frames:v.frames.map((f:any)=>({index:f.frameNum,score:f.metrics.cambi})),pooled,resources:{...resources.usage,stdoutBytes:resources.stdoutBytes,stderrBytes:resources.stderrBytes},outputBytes:outputBytes+resultStat.size};
 }
}
