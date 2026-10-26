import { apiError } from './api-error.ts';
import { DISCOVERY_LIMITS, preparationInput } from '../../shared/media/discovery.ts';
import type { DiscoverySource, DiscoveryStream, MediaProbe, PreparationInput, PreparationJob, DiscoveryDecision } from '../../shared/media/discovery.ts';
export type DiscoveryItem={source:DiscoverySource;file:{name:string;root:string;size:number;state:string};
  technical:{state:string;reason:string|null;preparedAt:number|null;digest:string|null;probe:MediaProbe|null;streams:DiscoveryStream[]};
  scoring:{state:string;reason:string;source:string;frames:string};links:{indexes:string};
  decision?:{state:DiscoveryDecision;reason:string|null;evidence:unknown[]}};
export type DiscoveryPage={schema:string;version:1;snapshot:string;entries:DiscoveryItem[];nextCursor:string|null;
  coverage:{total:number|null;candidates:{page:number;cumulative:number};page:{inspected:number;match:number;unknown:number;notMatch:number};cumulative:{inspected:number;match:number;unknown:number;notMatch:number};exhausted:boolean;totals:unknown}};
export class LibraryDiscoveryClient {
  async request<T>(url:string,actor:string,signal:AbortSignal,method='GET',body?:unknown,key?:string):Promise<T>{
    const response=await fetch(url,{method,cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{...(actor?{'x-voidplayer-actor':actor}:{}),
      ...(method==='GET'?{}:{'x-voidplayer-action':'library-preparation','content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const reader=response.body?.getReader();if(!reader)throw Error('Empty discovery response');let bytes=0,text='';const decoder=new TextDecoder();
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>DISCOVERY_LIMITS.responseBytes)throw Error('Discovery response exceeds client budget');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const value=JSON.parse(text);if(!response.ok)throw apiError(response.status,value);return value;
  }
  browse(params:URLSearchParams,actor:string,signal:AbortSignal){return this.request<DiscoveryPage>(`/api/library/discovery?${params}`,actor,signal);}
  detail(source:DiscoverySource,actor:string,signal:AbortSignal){return this.request<DiscoveryItem>(`/api/media/${source.id}/discovery?v=${source.version}`,actor,signal);}
  submit(input:PreparationInput,key:string,actor:string,signal:AbortSignal){return this.request<{job:PreparationJob;replayed:boolean}>('/api/library/preparations',actor,signal,'POST',preparationInput(input),key);}
  jobs(actor:string,signal:AbortSignal,before=0){return this.request<{jobs:PreparationJob[];next:number|null}>(`/api/library/preparations?before=${before}&limit=32`,actor,signal);}
  job(id:string,actor:string,signal:AbortSignal){return this.request<PreparationJob>(`/api/library/preparations/${id}`,actor,signal);}
  cancel(id:string,actor:string,signal:AbortSignal){return this.request<PreparationJob>(`/api/library/preparations/${id}/cancel`,actor,signal,'POST',{});}
}
