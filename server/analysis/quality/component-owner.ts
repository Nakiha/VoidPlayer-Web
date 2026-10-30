import {open,stat} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {webcrypto} from 'node:crypto';
import path from 'node:path';
import {AdminError} from '../../admin-error.ts';
import type {QualityAdmission} from '../../quality-admission.ts';
import {describeAnalysisComponent} from './analysis-component.ts';
type Metric='vmaf'|'xpsnr';
type Artifact=Pick<ReturnType<typeof describeAnalysisComponent>,'component'|'version'>;
const signature=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const files={'manifest.json':256*1024,'voidplayer-analysis.js':4*1024**2,'voidplayer-analysis.wasm':64*1024**2,'provenance.json':256*1024};
/** One application-owned verification at a time. Reads use async file handles;
 * SHA-256 runs in the crypto thread pool. No file IO in submission transactions.
 * A fresh execution verification still freezes and checks the actual artifact. */
export class AnalysisComponentOwner {
  private pending?:Promise<void>;
  private closed=false;
  private observing?:Promise<void>;
  private signatures=new Map<string,string>();
  private artifacts=new Map<Metric,Artifact>();
  private errors=new Map<Metric,unknown>();
  readonly ready:Promise<void>;
  readonly directory:string;
  private admission:QualityAdmission;
  constructor(directory:string,admission:QualityAdmission){
    this.directory=directory;this.admission=admission;
    this.ready=this.refresh().catch(error=>{this.errors.set('vmaf',error);this.errors.set('xpsnr',error);});
  }
  snapshot(metric:Metric):Artifact{
    if(this.closed)throw new AdminError(503,'Analysis component owner is closed','component-unavailable');
    const value=this.artifacts.get(metric);if(!value)throw this.errors.get(metric)??new AdminError(503,'Analysis component is not verified','component-unavailable');
    return structuredClone(value);
  }
  async verify(metric:Metric,admitted=false){
    if(admitted)await this.refresh(true);
    else if(this.pending)await this.pending;
    else {
      if(!this.observing){
        const observed=(async()=>{
          let changed=false;
          for(const name of Object.keys(files)){
            try{if(signature(await stat(path.join(this.directory,name),{bigint:true}))!==this.signatures.get(name))changed=true;}
            catch{changed=true;}
          }
          if(changed)await this.refresh();
        })();
        this.observing=observed;
        void observed.finally(()=>{if(this.observing===observed)this.observing=undefined;}).catch(()=>{});
      }
      await this.observing;
    }
    return this.snapshot(metric);
  }
  private refresh(admitted=false):Promise<void>{
    if(this.closed)return Promise.reject(new AdminError(503,'Analysis component owner is closed','component-unavailable'));
    if(this.pending)return this.pending;
    let release:()=>void;
    try{release=admitted?()=>{}:this.admission.acquire({executor:'inspection',memoryBytes:256*1024**2,readBytes:69*1024**2,threads:1});}
    catch(error){return Promise.reject(error);}
    const work=(async()=>{
      try{
        const data:Record<string,Buffer>={},hashes:Record<string,string>={},signatures=new Map<string,string>();
        for(const [name,limit]of Object.entries(files)){
          const handle=await open(path.join(this.directory,name),'r');
          try{
            const before=await handle.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(limit))throw Error('Analysis component file exceeds verification budget');
            const bytes=Buffer.alloc(Number(before.size));let at=0;
            while(at<bytes.length){const {bytesRead}=await handle.read(bytes,at,bytes.length-at,at);if(!bytesRead)throw Error('Analysis component file truncated');at+=bytesRead;}
            const after=await handle.stat({bigint:true});if(signature(after)!==signature(before))throw Error('Analysis component changed during verification');
            signatures.set(name,signature(after));
            data[name]=bytes;hashes[name]=Buffer.from(await webcrypto.subtle.digest('SHA-256',new Uint8Array(bytes.buffer as ArrayBuffer,bytes.byteOffset,bytes.byteLength))).toString('hex');
          }finally{await handle.close();}
        }
        this.signatures=signatures;
        for(const metric of ['vmaf','xpsnr'] as const){
          try{const {component,version}=describeAnalysisComponent(data,hashes,metric);this.artifacts.set(metric,{component,version});this.errors.delete(metric);}
          catch(error){this.artifacts.delete(metric);this.errors.set(metric,new AdminError(503,(error as Error).message,'component-unavailable'));}
        }
      }catch(error){
        const failure=new AdminError(503,`Analysis component verification failed: ${(error as Error).message}`,'component-unavailable');
        this.artifacts.clear();this.signatures.clear();this.errors.set('vmaf',failure);this.errors.set('xpsnr',failure);throw failure;
      }finally{release();}
    })();
    this.pending=work;
    void work.finally(()=>{if(this.pending===work)this.pending=undefined;}).catch(()=>{});
    return work;
  }
  async close(){this.closed=true;await Promise.allSettled([this.pending,this.observing]);this.artifacts.clear();this.signatures.clear();}
}
