import { apiError } from './api-error.ts';
import type { QualityJob, QualityJobInput, QualityJobPage, QualityJobResult } from '../../shared/analysis/quality/jobs.ts';
import type { QualityFramePage, QualityFrameQuery } from '../../shared/analysis/quality/selection.ts';
import type {LibraryPairBinding} from '../../shared/analysis/quality/library-pair.ts';
import {QUALITY_SOURCE_BUILD_LIMITS} from '../../shared/analysis/quality/source-build.ts';

export type QualityHistory = QualityJobPage & {resources:{queued:number;activeAttempts:number};limits:Record<string,number>};
export interface QualityTransport {
  changes(actor:string,after:number,signal:AbortSignal):Promise<QualityHistory>;
  get(actor:string,id:string,signal:AbortSignal):Promise<QualityJob>;
  result(actor:string,id:string,signal:AbortSignal):Promise<QualityJobResult>;
  submit(actor:string,input:QualityJobInput,key:string,signal:AbortSignal):Promise<{job:QualityJob;replayed:boolean}>;
  cancel(actor:string,id:string,signal:AbortSignal):Promise<QualityJob>;
}
/** An observation request can be aborted without cancelling the durable job. */
export class QualityClient implements QualityTransport {
  async request<T>(actor:string,url:string,signal:AbortSignal,method='GET',body?:unknown,key?:string,action='quality-job',timeoutMs=15000):Promise<T>{
    const response=await fetch(url,{method,cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),
      headers:{'x-voidplayer-actor':actor,...(method==='GET'?{}:{'content-type':'application/json','x-voidplayer-action':action}),...(key?{'idempotency-key':key}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    // History is bounded by 50 summaries; detail/result and candidates are much smaller.
    const max=2*1024*1024,reader=response.body?.getReader();let text='',bytes=0;
    if(!reader)throw new Error('Empty quality response');
    const decoder=new TextDecoder();
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
      if(bytes>max)throw new Error('Quality response exceeds client budget');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const value=JSON.parse(text);if(!response.ok)throw apiError(response.status,value);return value;
  }
  changes(actor:string,after:number,signal:AbortSignal){return this.request<QualityHistory>(actor,`/api/quality/jobs?after=${after}&limit=50`,signal);}
  get(actor:string,id:string,signal:AbortSignal){return this.request<QualityJob>(actor,`/api/quality/jobs/${encodeURIComponent(id)}`,signal);}
  result(actor:string,id:string,signal:AbortSignal){return this.request<QualityJobResult>(actor,`/api/quality/jobs/${encodeURIComponent(id)}/result`,signal);}
  submit(actor:string,input:QualityJobInput,key:string,signal:AbortSignal){return this.request<{job:QualityJob;replayed:boolean}>(actor,'/api/quality/jobs',signal,'POST',input,key);}
  cancel(actor:string,id:string,signal:AbortSignal){return this.request<QualityJob>(actor,`/api/quality/jobs/${encodeURIComponent(id)}/cancel`,signal,'POST',{});}
  frames(actor:string,id:string,version:string,query:QualityFrameQuery,signal:AbortSignal){
    const params=new URLSearchParams({v:version,afterAu:String(query.afterAu),limit:String(query.limit),...(query.buildId?{buildId:query.buildId}:{})});
    return this.request<QualityFramePage>(actor,`/api/media/${encodeURIComponent(id)}/psnr-frames?${params}`,signal);
  }
  source(actor:string,id:string,version:string,signal:AbortSignal){return this.request<LibraryPairBinding>(actor,`/api/media/${encodeURIComponent(id)}/psnr-source?v=${encodeURIComponent(version)}`,signal);}
  buildSource(actor:string,id:string,version:string,signal:AbortSignal){return this.request<LibraryPairBinding>(actor,`/api/media/${encodeURIComponent(id)}/psnr-index`,signal,'POST',{version},undefined,'quality-source-build',QUALITY_SOURCE_BUILD_LIMITS.maxElapsedMs+5000);}
}
