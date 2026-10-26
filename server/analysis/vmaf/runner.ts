import {Worker} from 'node:worker_threads';import {spawn} from 'node:child_process';
import {mkdirSync,copyFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {AdminError} from '../../admin-error.ts';import type {MediaLibraryIndex} from '../../library.ts';
import {VMAF_LIMITS,VMAF_CAPABILITY,VmafError} from '../../../shared/analysis/quality/vmaf.ts';
import type {VmafComponentConfig,VmafInput,VmafModel,VmafPlanSnapshot,VmafPrepared,VmafNativeResult} from '../../../shared/analysis/quality/vmaf.ts';
import type {VmafComponent} from './component.ts';
declare const VOIDPLAYER_COMPILED:boolean;
type Hooks={admitted():void;phase(name:string):void;progress(frames:number,total:number):void;prepared(value:VmafPrepared):void;process(value:{pid:number;startTicks:string;bootId:string}|null):void};
const sleep=()=>new Promise<void>(r=>setTimeout(r,10));
export function processStartTicks(pid:number){try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return fields[0]==='Z'?null:fields[19];}catch{return null;}}
/** Recovery never starts another execution while a durably-owned old supervisor lives. */
export async function stopOwnedNative(process:{pid:number;startTicks:string;bootId:string}){
 if(globalThis.process.platform!=='linux')return;
 if(!Number.isSafeInteger(process.pid)||process.pid<1||typeof process.startTicks!=='string'||!/^\d+$/.test(process.startTicks)||typeof process.bootId!=='string'||!/^[a-f0-9-]{36}$/.test(process.bootId))throw new VmafError('stop-uncertain','Durable native ownership witness is invalid');
 if(readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==process.bootId)return;
 if(processStartTicks(process.pid)!==process.startTicks)return;
 try{globalThis.process.kill(-process.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 const until=Date.now()+2000;while(processStartTicks(process.pid)===process.startTicks){if(Date.now()>until)throw new VmafError('stop-uncertain','Previous native process did not exit');await sleep();}
}
export class NativeVmafRunner{
 private active=new Set<{stop():void;done:Promise<unknown>}>();private closed=false;stopUncertain=false;
 protected library:MediaLibraryIndex;protected coreDir:string;readonly config:VmafComponentConfig|undefined;
 constructor(library:MediaLibraryIndex,coreDir:string,config:VmafComponentConfig|undefined){this.library=library;this.coreDir=coreDir;this.config=config;}
 async capability(){
  const basic={...VMAF_CAPABILITY,configured:!!this.config,enabled:false,reason:'component-unavailable'};
  if(!this.config||process.platform!=='linux'||process.arch!=='x64')return basic;
  try{const c=await this.owned({budget:{maxElapsedMs:30000}},new AbortController().signal,()=>{},s=>this.component('vmaf_v0_6_1',s));return {...basic,enabled:true,reason:null,component:{manifestSha256:c.manifestSha256,sourceRevision:c.sourceRevision,cliVersion:c.cliVersion}};}
  catch(error){return {...basic,reason:(error as {code?:string}).code??'component-unavailable'};}
 }
 protected async component(model:VmafModel,signal:AbortSignal){
  signal.throwIfAborted();if(!this.config)throw new VmafError('component-unavailable','No native VMAF component configured');
  return this.worker<VmafComponent>('component-worker.ts',{config:this.config,model},signal);
 }
 protected worker<T>(entry:string,data:object,signal:AbortSignal,progress?:(n:number,total:number)=>void):Promise<T>{
  const control=new Int32Array(new SharedArrayBuffer(8));
  const url=new URL(typeof VOIDPLAYER_COMPILED!=='undefined'&&VOIDPLAYER_COMPILED?`./analysis/vmaf/${entry}`:`./${entry}`,import.meta.url);
  const worker=new Worker(url,{workerData:{...data,control:control.buffer},resourceLimits:{maxOldGenerationSizeMb:256},trackUnmanagedFds:true});
  return new Promise<T>((resolve,reject)=>{
   let finishing=false,exited=false;
   const finish=async(ok:boolean,value:unknown)=>{
    if(finishing)return;finishing=true;signal.removeEventListener('abort',abort);Atomics.store(control,0,1);
    try{
     for(;;){const n=Atomics.load(control,1);if(!n)break;if(exited)throw new VmafError('stop-uncertain','Decode Worker exited with open source IO');const w=(Atomics as typeof Atomics&{waitAsync(a:Int32Array,i:number,n:number):{value:Promise<string>|string}}).waitAsync(control,1,n);await w.value;}
     await worker.terminate();if(signal.aborted)reject(signal.reason);else if(ok)resolve(value as T);else reject(value);
    }catch(error){this.stopUncertain=true;reject(error);}
    finally{worker.removeAllListeners();}
   };
   const abort=()=>void finish(false,signal.reason);
   worker.on('message',message=>{if(finishing)return;if(message.type==='progress'){try{progress?.(message.frames,message.total);}catch(error){void finish(false,error);}return;}void finish(message.ok===true,message.ok?message.value:new VmafError(message.error?.code??'execution-failed',message.error?.message??'VMAF Worker failed'));});
   worker.once('error',error=>void finish(false,error));worker.once('messageerror',()=>void finish(false,new VmafError('execution-failed','Invalid Worker reply')));worker.once('exit',()=>{exited=true;Atomics.notify(control,1);if(!finishing)void finish(false,new VmafError('execution-failed','VMAF Worker exited without a result'));});
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }
 async preflight(input:VmafInput,snapshot:VmafPlanSnapshot,signal:AbortSignal){
  return this.owned(input,signal,()=>{},async combined=>{const c=await this.component(input.model,combined);combined.throwIfAborted();const value=await this.worker('decode-worker.ts',{mode:'preflight',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory:''},combined);return {eligibility:value,component:{manifestSha256:c.manifestSha256,modelSha256:c.modelSha256},rawColorVerification:'required-at-execution',nativeExecution:false};});
 }
 async run(input:VmafInput,snapshot:VmafPlanSnapshot,signal:AbortSignal,hooks:Hooks){
  return this.owned(input,signal,hooks.admitted,async combined=>{
   const directory=path.join(this.library.indexDatabase+'.vmaf-tmp',randomUUID());let temporary=false;
   try{
    hooks.phase('component');const c=await this.component(input.model,combined);combined.throwIfAborted();
    mkdirSync(directory,{recursive:true,mode:0o700});temporary=true;hooks.phase('decode');
    const prepared=await this.worker<VmafPrepared>('decode-worker.ts',{mode:'decode',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory},combined,hooks.progress);combined.throwIfAborted();hooks.prepared(prepared);
    hooks.phase('native');const native=await this.native(c,directory,input,prepared,combined,hooks.process);combined.throwIfAborted();
    hooks.phase('source-final');const verification=await this.worker<{indexBytes:number;indexPackets:number;elapsedMs:number}>('decode-worker.ts',{mode:'verify',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory},combined);combined.throwIfAborted();if(prepared.work.indexBytes+verification.indexBytes>VMAF_LIMITS.maxIndexBytes||prepared.work.indexPackets+verification.indexPackets>VMAF_LIMITS.maxIndexPackets)throw new VmafError('budget-exceeded','Final verification exceeds cumulative index budget');native.resources.finalVerification={indexBytes:verification.indexBytes,indexPackets:verification.indexPackets,elapsedMs:verification.elapsedMs};return {prepared,native};
   }finally{if(temporary&&!this.stopUncertain)try{rmSync(directory,{recursive:true,force:true});}catch(error){this.stopUncertain=true;throw new VmafError('stop-uncertain','Temporary raw sequence could not be reclaimed');}}
  });
 }
 protected owned<T>(input:{budget:{maxElapsedMs:number}},signal:AbortSignal,admitted:()=>void,work:(s:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.closed||this.stopUncertain)return Promise.reject(new VmafError('component-unavailable','Native executor is stopping or unavailable'));
  let release:()=>void;try{signal.throwIfAborted();release=this.library.qualityAdmission.acquire();}catch(error){return Promise.reject(error);}
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  const timer=setTimeout(()=>controller.abort(new VmafError('budget-exceeded','Whole VMAF execution deadline exceeded')),input.budget.maxElapsedMs);
  const entry={stop:()=>controller.abort(new VmafError('cancelled','Native VMAF executor stopping')),done:Promise.resolve() as Promise<unknown>};
  const done=Promise.resolve().then(async()=>{try{admitted();combined.throwIfAborted();return await work(combined);}finally{clearTimeout(timer);this.active.delete(entry);if(!this.stopUncertain)release();}});
  entry.done=done;this.active.add(entry);return done;
 }
 private async native(c:VmafComponent,directory:string,input:VmafInput,prepared:VmafPrepared,signal:AbortSignal,onProcess:Hooks['process']):Promise<VmafNativeResult>{
  signal.throwIfAborted();copyFileSync(c.model,path.join(directory,'model.json'));
  const expected=prepared.geometry.width*prepared.geometry.height*3/2*(prepared.geometry.bitDepth===8?1:2)*prepared.pairs.length;
  for(const name of ['reference.yuv','distorted.yuv'])if(statSync(path.join(directory,name)).size!==expected)throw new VmafError('source-io-failed','Raw sequence length differs from the frozen frame count');
  const args=[String(input.budget.nativeCpuSeconds),String(input.budget.nativeMemoryBytes),String(VMAF_LIMITS.resultBytes),c.binary,
   '--reference','reference.yuv','--distorted','distorted.yuv','--width',String(prepared.geometry.width),'--height',String(prepared.geometry.height),'--pixel_format','420','--bitdepth',String(prepared.geometry.bitDepth),'--model','path=model.json:name=vmaf','--threads','1','--cpumask','0','--json','--output','result.json','--quiet'];
  const {usage,stdoutBytes,stderrBytes}=await this.executeNative(c,directory,args,signal,onProcess);
  if(statSync(path.join(directory,'result.json')).size>VMAF_LIMITS.resultBytes)throw new VmafError('budget-exceeded','Native result exceeds limit');
  const value=JSON.parse(readFileSync(path.join(directory,'result.json'),'utf8'));
  if(value.version!==c.cliVersion||!Array.isArray(value.frames)||value.frames.length!==prepared.pairs.length||value.frames.some((f:any,i:number)=>f.frameNum!==i||(!Number.isFinite(f.metrics?.vmaf)||f.metrics.vmaf<0||f.metrics.vmaf>100)))throw new VmafError('native-result-invalid','Native frame count/order/score differs from the frozen sequence');
  const pooled=value.pooled_metrics?.vmaf;if(!pooled||['min','max','mean','harmonic_mean'].some(k=>!Number.isFinite(pooled[k])))throw new VmafError('native-result-invalid','Missing official pooled scores');
  return {frames:value.frames.map((f:any)=>({index:f.frameNum,score:f.metrics.vmaf})),pooled,version:value.version,component:{manifestSha256:c.manifestSha256,binarySha256:c.binarySha256,modelSha256:c.modelSha256,supervisorSha256:c.supervisorSha256,sourceRevision:c.sourceRevision},
   recipe:{model:input.model,threads:1,cpuMask:0,subsample:1,pooling:'official-mean-min-max-harmonic',preprocessing:'none',range:'limited',color:'bt709-sdr',pixelFormat:prepared.geometry.bitDepth===8?'yuv420p':'yuv420p10le',...prepared.geometry,boundary:'clip-reset-and-final-flush',rawPacking:'visible-y-u-v-tight-little-endian-v1'},resources:{...usage,stdoutBytes,stderrBytes}};
 }
 protected async executeNative(c:VmafComponent,directory:string,args:string[],signal:AbortSignal,onProcess:Hooks['process']){
  const child=spawn(c.supervisor,args,{cwd:directory,detached:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C',LC_ALL:'C'}});
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,reason:unknown,nativePid:number|undefined,usage:VmafNativeResult['resources']|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=(why:unknown)=>{if(reason===undefined)reason=why;if(!child.pid)return;child.kill('SIGTERM');killTimer??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1000);};
  const abort=()=>stop(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const collect=(kind:'stdout'|'stderr',chunk:Buffer)=>{
   if(kind==='stdout'){stdoutBytes+=chunk.length;if(stdoutBytes<=VMAF_LIMITS.stdoutBytes)stdout+=chunk.toString();}
   else{stderrBytes+=chunk.length;if(stderrBytes<=VMAF_LIMITS.stdoutBytes)stderr+=chunk.toString();}
   if(stdoutBytes>VMAF_LIMITS.stdoutBytes||stderrBytes>VMAF_LIMITS.stdoutBytes)stop(new VmafError('budget-exceeded','Native stdout/stderr limit exceeded'));
  };
  child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
  let spawnFailure:unknown;
  child.once('spawn',()=>{try{signal.throwIfAborted();const startTicks=processStartTicks(child.pid!);if(!startTicks)throw new VmafError('native-execution-failed','Cannot witness the native supervisor');onProcess({pid:child.pid!,startTicks,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()});child.stdin.end('G');}catch(error){stop(error);child.stdin.end();}});
  child.on('error',error=>{spawnFailure=error;});child.stdin.on('error',()=>{});
  const code=await new Promise<number|null>(resolve=>child.once('close',resolve));
  signal.removeEventListener('abort',abort);clearTimeout(killTimer);
  nativePid=Number(/^VOIDPLAYER_VMAF_PID (\d+)$/m.exec(stdout)?.[1]);
  if(nativePid&&processStartTicks(nativePid)!==null){this.stopUncertain=true;throw new VmafError('stop-uncertain','Native child still exists after supervisor exit');}
  onProcess(null);
  if(signal.aborted)throw signal.reason;if(reason!==undefined)throw reason;if(spawnFailure)throw new VmafError('component-unavailable','Native executable could not start');
  const text=/^VOIDPLAYER_VMAF_USAGE (\{.*\})$/m.exec(stdout)?.[1];if(text)usage=JSON.parse(text);
  if(code!==0||!usage||usage.exitCode!==0||usage.signal!==0)throw new VmafError('native-execution-failed',`Native VMAF did not complete (supervisor=${code}, child=${usage?.exitCode??'unknown'}, signal=${usage?.signal??'unknown'}, cpuMs=${usage?.cpuMs??'unknown'}, peakRssBytes=${usage?.peakRssBytes??'unknown'}); no native score committed`);
  return {usage,stdoutBytes,stderrBytes};
 }

 close(){this.closed=true;for(const e of this.active)e.stop();return Promise.allSettled([...this.active].map(e=>e.done)).then(()=>{if(this.stopUncertain)throw new VmafError('stop-uncertain','Native executor exit is uncertain');});}
}
