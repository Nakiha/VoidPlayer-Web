import { Worker } from 'node:worker_threads';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_RECIPE,ANALYZER_VERSION,BUDGET,validateResult,validateTarget,validateRange,pictureId } from '../../src/bitstream-analysis/contract.ts';
import type { AnalysisResult,AnalysisTarget,AnalysisRangeTarget } from '../../src/bitstream-analysis/contract.ts';
import { AnalysisStore } from './store.ts';
import type { MediaLibraryIndex } from '../library.ts';
type Work={id:string;mediaId:string;version:string;filePath:string;target:AnalysisTarget|AnalysisRangeTarget;chunks:string[];buildId:string;state:'queued'|'running'|'complete'|'error'|'cancelled';error?:string;consumers:Set<string>;worker?:Worker;seq:number;};
type Consumer={work:Work;owner:string;expires:number;};
/** Independent one-worker queue. Request leases are separate from shared work. */
export class AnalysisScheduler {
 private work=new Map<string,Work>();private consumers=new Map<string,Consumer>();private running?:Work;private timer?:ReturnType<typeof setInterval>;private closed=false;
 private submissions:Promise<unknown>=Promise.resolve();
 readonly store:AnalysisStore;
 private library:MediaLibraryIndex;private coreDir:string;private now:()=>number;private leaseMs:number;
 constructor(library:MediaLibraryIndex,coreDir:string,directory:string,now=()=>Date.now(),leaseMs:number=BUDGET.leaseMs){this.library=library;this.coreDir=coreDir;this.now=now;this.leaseMs=leaseMs;this.store=new AnalysisStore(directory);}
 submit(mediaId:string,version:string,target:AnalysisTarget|AnalysisRangeTarget,owner:string){const task=this.submissions.then(()=>this.submitInner(mediaId,version,target,owner));this.submissions=task.catch(()=>{});return task;}
 private async submitInner(mediaId:string,version:string,target:AnalysisTarget|AnalysisRangeTarget,owner:string){
  if(this.closed)throw new Error('Analysis service closed');if('startUs' in target)validateRange(target);else validateTarget(target);
  if(target.sourceVersion!==`${mediaId}@${version}`)throw new Error('Analysis source version mismatch');
  if(this.consumers.size>=BUDGET.requests)throw new Error('Analysis request queue full');
  const filePath=await this.library.resolve(mediaId,version);if(!filePath)throw new Error('Analysis media version changed');
  const manifest=JSON.parse(await readFile(path.join(this.coreDir,'manifest.json'),'utf8'));if(manifest.abi!==1||manifest.semanticVersion!==ANALYZER_VERSION)throw new Error('Analysis core ABI/version mismatch');
  const id=createHash('sha256').update(JSON.stringify([target.sourceVersion,'startUs' in target?[target.firstPtsUs,target.startUs,target.endUs]:target.picture?pictureId(target.picture):target.sourcePtsUs,ANALYSIS_RECIPE,ANALYZER_VERSION,manifest.revision])).digest('hex');
  let work=this.work.get(id);
  if(work?.state==='complete'&&!(await Promise.all(work.chunks.map(chunk=>this.store.get(chunk)))).every(Boolean)){this.work.delete(id);work=undefined;}
  if(!work||work.state==='cancelled'||work.state==='error'){
   const chunks='startUs' in target?await this.store.manifest(id):null;const cached='startUs' in target?null:await this.store.get(id);if(cached&&(cached.buildId!==manifest.revision||cached.picture.sourceVersion!==target.sourceVersion))throw new Error('Invalid analysis cache identity');
   work={id,mediaId,version,filePath,target,chunks:chunks??(cached?[id]:[]),buildId:manifest.revision,state:cached||chunks?'complete':'queued',consumers:new Set(),seq:0};this.work.set(id,work);
  }
  const requestId=randomUUID();work.consumers.add(requestId);this.consumers.set(requestId,{work,owner,expires:this.now()+this.leaseMs});
  if(!this.timer){this.timer=setInterval(()=>this.expire(),1000);this.timer.unref();}
  void this.pump();return{requestId,state:work.state,leaseMs:this.leaseMs,cacheHit:work.state==='complete'};
 }
 status(id:string,owner:string){const consumer=this.consumers.get(id);if(!consumer||consumer.owner!==owner||consumer.expires<=this.now())return null;consumer.expires=this.now()+this.leaseMs;const w=consumer.work;return {state:w.state,seq:w.seq,error:w.error,leaseMs:this.leaseMs,chunks:w.chunks.map(id=>({id,url:`/api/media/${w.mediaId}/bitstream-analysis/chunks/${id}?v=${w.version}`})),...(!('startUs' in w.target)&&w.state==='complete'?{resultUrl:`/api/media/${w.mediaId}/bitstream-analysis/chunks/${w.id}?v=${w.version}`}:{})};}
 release(id:string,owner?:string){const c=this.consumers.get(id);if(!c||owner!==undefined&&c.owner!==owner)return false;this.consumers.delete(id);c.work.consumers.delete(id);if(!c.work.consumers.size){if(c.work.state==='queued'||c.work.state==='running'){c.work.state='cancelled';c.work.seq++;void c.work.worker?.terminate();}this.work.delete(c.work.id);}return true;}
 expire(){for(const [id,c]of this.consumers)if(c.expires<=this.now())this.release(id);}
 private async pump(){
  if(this.closed||this.running)return;const work=[...this.work.values()].find(w=>w.state==='queued'&&w.consumers.size);if(!work)return;
  this.running=work;work.state='running';work.seq++;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!await this.library.resolve(work.mediaId,work.version))throw new Error('Analysis media changed before execution');
   if(this.closed||work.state!=='running'||!work.consumers.size)return;
   const worker=work.worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:{filePath:work.filePath,coreDir:this.coreDir,target:work.target}});
   await new Promise<void>((resolve,reject)=>{
    timer=setTimeout(()=>{void worker.terminate();reject(new Error('Analysis execution time budget exceeded'));},30000);
    worker.on('message',async m=>{
     if(m.type==='chunk'){
      try{
       if(work.state!=='running'||!work.consumers.size)throw new Error('Analysis demand expired');
       const result:AnalysisResult=m.result;validateResult(result);
       if(result.picture.sourceVersion!==work.target.sourceVersion||result.buildId!==work.buildId)throw new Error('Analysis worker identity mismatch');
       if(!('startUs' in work.target)&&(result.sourcePtsUs!==work.target.sourcePtsUs||work.target.picture&&pictureId(result.picture)!==pictureId(work.target.picture)))throw new Error('Analysis worker target mismatch');
       if(!await this.library.resolve(work.mediaId,work.version))throw new Error('Analysis source changed during execution');
       if(result.confidence!=='exact')throw new Error(result.reasons.join('; '));
       const chunk='startUs' in work.target?createHash('sha256').update(JSON.stringify([result.picture.sourceVersion,pictureId(result.picture),ANALYSIS_RECIPE,ANALYZER_VERSION,work.buildId])).digest('hex'):work.id;
       if(work.chunks.length>=32)throw new Error('Analysis chunk count budget exceeded');
       await this.store.put(chunk,result);work.chunks.push(chunk);work.seq++;worker.postMessage({ok:true});
      }catch(error){worker.postMessage({ok:false,error:String(error)});reject(error);}
     }else m.ok?resolve():reject(new Error(m.error));
    });worker.once('error',reject);worker.once('exit',()=>reject(new Error('Analysis worker exited')));
   });
   if(work.state!=='running'||!work.consumers.size)return;
   if('startUs' in work.target)await this.store.putManifest(work.id,work.chunks);
   work.state='complete';work.seq++;
  }catch(error){if(work.state==='running'){work.state='error';work.error=error instanceof Error?error.message:String(error);work.seq++;}}
  finally{clearTimeout(timer);await work.worker?.terminate();work.worker=undefined;this.running=undefined;void this.pump();}
 }
 async close(){this.closed=true;clearInterval(this.timer);for(const id of this.consumers.keys())this.release(id);await this.running?.worker?.terminate();}
}
