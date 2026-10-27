import {Worker} from 'node:worker_threads';import {spawn} from 'node:child_process';
import {mkdirSync,copyFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {AdminError} from '../../admin-error.ts';import type {MediaLibraryIndex} from '../../library.ts';
import {XPSNR_LIMITS,XPSNR_CAPABILITY,XpsnrError,parseXpsnrStatistics,XPSNR_RECIPE} from '../../../shared/analysis/quality/xpsnr.ts';
import type {XpsnrComponentConfig,XpsnrInput,XpsnrPlanSnapshot,XpsnrPrepared,XpsnrNativeResult} from '../../../shared/analysis/quality/xpsnr.ts';
import type {XpsnrComponent} from './component.ts';
declare const VOIDPLAYER_COMPILED:boolean;
type Hooks={admitted():void;phase(name:string):void;progress(frames:number,total:number):void;prepared(value:XpsnrPrepared):void;process(value:{pid:number;startTicks:string;bootId:string}|null):void};
const sleep=()=>new Promise<void>(r=>setTimeout(r,10));
import {processStartTicks,stopOwnedNative} from '../vmaf/runner.ts';
export {stopOwnedNative};
export class NativeXpsnrRunner{
 private active=new Set<{stop():void;done:Promise<unknown>}>();private closed=false;stopUncertain=false;
 private library:MediaLibraryIndex;private coreDir:string;readonly config:XpsnrComponentConfig|undefined;
 constructor(library:MediaLibraryIndex,coreDir:string,config:XpsnrComponentConfig|undefined){this.library=library;this.coreDir=coreDir;this.config=config;}
 async capability(){
  const basic={...XPSNR_CAPABILITY,configured:!!this.config,enabled:false,reason:'component-unavailable'};
  if(!this.config||process.platform!=='linux'||process.arch!=='x64')return basic;
  try{const c=await this.owned({budget:{maxElapsedMs:30000}},new AbortController().signal,()=>{},s=>this.component(s));return {...basic,enabled:true,reason:null,component:{manifestSha256:c.manifestSha256,sourceRevision:c.sourceRevision,cliVersion:c.cliVersion}};}
  catch(error){return {...basic,reason:(error as {code?:string}).code??'component-unavailable'};}
 }
 private async component(signal:AbortSignal){
  signal.throwIfAborted();if(!this.config)throw new XpsnrError('component-unavailable','No native XPSNR component configured');
  return this.worker<XpsnrComponent>('component-worker.ts',{config:this.config},signal);
 }
 private worker<T>(entry:string,data:object,signal:AbortSignal,progress?:(n:number,total:number)=>void):Promise<T>{
  const control=new Int32Array(new SharedArrayBuffer(8));
  const url=new URL(typeof VOIDPLAYER_COMPILED!=='undefined'&&VOIDPLAYER_COMPILED?`./analysis/xpsnr/${entry}`:`./${entry}`,import.meta.url);
  const worker=new Worker(url,{workerData:{...data,control:control.buffer},resourceLimits:{maxOldGenerationSizeMb:256},trackUnmanagedFds:true});
  return new Promise<T>((resolve,reject)=>{
   let finishing=false,exited=false;
   const finish=async(ok:boolean,value:unknown)=>{
    if(finishing)return;finishing=true;signal.removeEventListener('abort',abort);Atomics.store(control,0,1);
    try{
     for(;;){const n=Atomics.load(control,1);if(!n)break;if(exited)throw new XpsnrError('stop-uncertain','Decode Worker exited with open source IO');const w=(Atomics as typeof Atomics&{waitAsync(a:Int32Array,i:number,n:number):{value:Promise<string>|string}}).waitAsync(control,1,n);await w.value;}
     await worker.terminate();if(signal.aborted)reject(signal.reason);else if(ok)resolve(value as T);else reject(value);
    }catch(error){this.stopUncertain=true;reject(error);}
    finally{worker.removeAllListeners();}
   };
   const abort=()=>void finish(false,signal.reason);
   worker.on('message',message=>{if(finishing)return;if(message.type==='progress'){try{progress?.(message.frames,message.total);}catch(error){void finish(false,error);}return;}void finish(message.ok===true,message.ok?message.value:new XpsnrError(message.error?.code??'execution-failed',message.error?.message??'XPSNR Worker failed'));});
   worker.once('error',error=>void finish(false,error));worker.once('messageerror',()=>void finish(false,new XpsnrError('execution-failed','Invalid Worker reply')));worker.once('exit',()=>{exited=true;Atomics.notify(control,1);if(!finishing)void finish(false,new XpsnrError('execution-failed','XPSNR Worker exited without a result'));});
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }
 async preflight(input:XpsnrInput,snapshot:XpsnrPlanSnapshot,signal:AbortSignal){
  return this.owned(input,signal,()=>{},async combined=>{const c=await this.component(combined);combined.throwIfAborted();const value=await this.worker('decode-worker.ts',{mode:'preflight',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory:''},combined);return {eligibility:value,component:{manifestSha256:c.manifestSha256,filterSha256:c.filterSha256},rawColorVerification:'required-at-execution',nativeExecution:false};});
 }
 async run(input:XpsnrInput,snapshot:XpsnrPlanSnapshot,signal:AbortSignal,hooks:Hooks){
  return this.owned(input,signal,hooks.admitted,async combined=>{
   const directory=path.join(this.library.indexDatabase+'.xpsnr-tmp',randomUUID());let temporary=false;
   try{
    hooks.phase('component');const c=await this.component(combined);combined.throwIfAborted();
    mkdirSync(directory,{recursive:true,mode:0o700});temporary=true;hooks.phase('decode');
    const prepared=await this.worker<XpsnrPrepared>('decode-worker.ts',{mode:'decode',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory},combined,hooks.progress);combined.throwIfAborted();hooks.prepared(prepared);
    hooks.phase('native');const native=await this.native(c,directory,input,prepared,combined,hooks.process);combined.throwIfAborted();
    hooks.phase('source-final');const verification=await this.worker<{indexBytes:number;indexPackets:number;elapsedMs:number}>('decode-worker.ts',{mode:'verify',database:this.library.indexDatabase,coreDir:this.coreDir,input,snapshot,directory},combined);combined.throwIfAborted();if(prepared.work.indexBytes+verification.indexBytes>XPSNR_LIMITS.maxIndexBytes||prepared.work.indexPackets+verification.indexPackets>XPSNR_LIMITS.maxIndexPackets)throw new XpsnrError('budget-exceeded','Final verification exceeds cumulative index budget');native.resources.finalVerification={indexBytes:verification.indexBytes,indexPackets:verification.indexPackets,elapsedMs:verification.elapsedMs};return {prepared,native};
   }finally{if(temporary&&!this.stopUncertain)try{rmSync(directory,{recursive:true,force:true});}catch(error){this.stopUncertain=true;throw new XpsnrError('stop-uncertain','Temporary raw sequence could not be reclaimed');}}
  });
 }
 private owned<T>(input:{budget:{maxElapsedMs:number}},signal:AbortSignal,admitted:()=>void,work:(s:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.closed||this.stopUncertain)return Promise.reject(new XpsnrError('component-unavailable','Native executor is stopping or unavailable'));
  let release:()=>void;try{signal.throwIfAborted();release=this.library.qualityAdmission.acquire();}catch(error){return Promise.reject(error);}
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  const timer=setTimeout(()=>controller.abort(new XpsnrError('budget-exceeded','Whole XPSNR execution deadline exceeded')),input.budget.maxElapsedMs);
  const entry={stop:()=>controller.abort(new XpsnrError('cancelled','Native XPSNR executor stopping')),done:Promise.resolve() as Promise<unknown>};
  const done=Promise.resolve().then(async()=>{try{admitted();combined.throwIfAborted();return await work(combined);}finally{clearTimeout(timer);this.active.delete(entry);if(!this.stopUncertain)release();}});
  entry.done=done;this.active.add(entry);return done;
 }
 private async native(c:XpsnrComponent,directory:string,input:XpsnrInput,prepared:XpsnrPrepared,signal:AbortSignal,onProcess:Hooks['process']):Promise<XpsnrNativeResult>{
  signal.throwIfAborted();
  const expected=prepared.geometry.width*prepared.geometry.height*3/2*(prepared.geometry.bitDepth===8?1:2)*prepared.pairs.length;
  for(const name of ['reference.yuv','distorted.yuv'])if(statSync(path.join(directory,name)).size!==expected)throw new XpsnrError('source-io-failed','Raw sequence length differs from the frozen frame count');
  const g=prepared.geometry,pixelFormat=g.bitDepth===8?'yuv420p':'yuv420p10le';
  const raw=['-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${g.width}x${g.height}`,'-framerate',`1000000/${input.cadenceUs}`];
  const args=[String(input.budget.nativeCpuSeconds),String(input.budget.nativeMemoryBytes),String(XPSNR_LIMITS.resultBytes),c.binary,
   '-hide_banner','-nostdin','-loglevel','info','-cpuflags','0','-filter_complex_threads','1','-threads','1',...raw,'-i','reference.yuv','-threads','1',...raw,'-i','distorted.yuv',
   '-filter_complex','[0:v][1:v]xpsnr=stats_file=result.txt:shortest=1:repeatlast=0[out]','-map','[out]','-threads','1','-f','null','-'];
  const child=spawn(c.supervisor,args,{cwd:directory,detached:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C',LC_ALL:'C'}});
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,reason:unknown,nativePid:number|undefined,usage:XpsnrNativeResult['resources']|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=(why:unknown)=>{if(reason===undefined)reason=why;if(!child.pid)return;child.kill('SIGTERM');killTimer??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1000);};
  const abort=()=>stop(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const collect=(kind:'stdout'|'stderr',chunk:Buffer)=>{
   if(kind==='stdout'){stdoutBytes+=chunk.length;if(stdoutBytes<=XPSNR_LIMITS.stdoutBytes)stdout+=chunk.toString();}
   else{stderrBytes+=chunk.length;if(stderrBytes<=XPSNR_LIMITS.stdoutBytes)stderr+=chunk.toString();}
   if(stdoutBytes>XPSNR_LIMITS.stdoutBytes||stderrBytes>XPSNR_LIMITS.stdoutBytes)stop(new XpsnrError('budget-exceeded','Native stdout/stderr limit exceeded'));
  };
  child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
  let spawnFailure:unknown;
  child.once('spawn',()=>{try{signal.throwIfAborted();const startTicks=processStartTicks(child.pid!);if(!startTicks)throw new XpsnrError('native-execution-failed','Cannot witness the native supervisor');onProcess({pid:child.pid!,startTicks,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()});child.stdin.end('G');}catch(error){stop(error);child.stdin.end();}});
  child.on('error',error=>{spawnFailure=error;});child.stdin.on('error',()=>{});
  const code=await new Promise<number|null>(resolve=>child.once('close',resolve));
  signal.removeEventListener('abort',abort);clearTimeout(killTimer);
  nativePid=Number(/^VOIDPLAYER_VMAF_PID (\d+)$/m.exec(stdout)?.[1]);
  if(nativePid&&processStartTicks(nativePid)!==null){this.stopUncertain=true;throw new XpsnrError('stop-uncertain','Native child still exists after supervisor exit');}
  onProcess(null);
  if(signal.aborted)throw signal.reason;if(reason!==undefined)throw reason;if(spawnFailure)throw new XpsnrError('component-unavailable','Native executable could not start');
  const text=/^VOIDPLAYER_VMAF_USAGE (\{.*\})$/m.exec(stdout)?.[1];if(text)usage=JSON.parse(text);
  if(code!==0||!usage||usage.exitCode!==0||usage.signal!==0)throw new XpsnrError('native-execution-failed',`Native XPSNR did not complete (supervisor=${code}, child=${usage?.exitCode??'unknown'}, signal=${usage?.signal??'unknown'}, cpuMs=${usage?.cpuMs??'unknown'}, peakRssBytes=${usage?.peakRssBytes??'unknown'}); no native score committed`);
  if(statSync(path.join(directory,'result.txt')).size>XPSNR_LIMITS.resultBytes)throw new XpsnrError('budget-exceeded','Native result exceeds limit');
  const textResult=readFileSync(path.join(directory,'result.txt'),'utf8'),value=parseXpsnrStatistics(textResult,prepared.pairs.length);
  return {...value,statistics:{format:'ffmpeg-xpsnr-stats-4-decimal-v1',text:textResult,sha256:createHash('sha256').update(textResult).digest('hex')},version:c.cliVersion,
   component:{manifestSha256:c.manifestSha256,binarySha256:c.binarySha256,filterSha256:c.filterSha256,supervisorSha256:c.supervisorSha256,sourceRevision:c.sourceRevision},
   recipe:{id:XPSNR_RECIPE,threads:1,cpuFlags:0,inputOrder:'reference-distorted',pooling:'official-square-mean-root-with-low-distortion-log-fallback',preprocessing:'none',range:'limited',color:'bt709-sdr',pixelFormat,...prepared.geometry,cadenceUs:input.cadenceUs,frameRate:{numerator:1000000,denominator:input.cadenceUs},boundary:'clip-reset-and-final-flush',rawPacking:'visible-y-u-v-tight-little-endian-v1'},resources:{...usage,stdoutBytes,stderrBytes}};
 }

 close(){this.closed=true;for(const e of this.active)e.stop();return Promise.allSettled([...this.active].map(e=>e.done)).then(()=>{if(this.stopUncertain)throw new XpsnrError('stop-uncertain','Native executor exit is uncertain');});}
}
