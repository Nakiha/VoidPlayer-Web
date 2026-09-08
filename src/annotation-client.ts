import { currentActor } from './identity.ts';
import type { AnnotationOperation, AnnotationPage, AnnotationRecord } from './annotation-record.ts';
export class AnnotationClient {
  constructor(private signal: AbortSignal) {}
  async request<T>(url: string, method='GET', body?: unknown, actor=currentActor()?.id): Promise<T> {
    const response=await fetch(url,{method,cache:'no-store',headers:{...(actor?{'x-voidplayer-actor':actor}:{}),...(method==='GET'?{}:{'x-voidplayer-action':'annotation','content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([this.signal,AbortSignal.timeout(10000)])});
    const result=await response.json(); if(!response.ok)throw Object.assign(new Error(result.error ?? `请求失败 (${response.status})`),{status:response.status});return result;
  }
  spaces(){return this.request<{id:string;name:string}[]>('/api/annotations/spaces');}
  createSpace(name:string){return this.request<{id:string;name:string}>('/api/annotations/spaces','POST',{name});}
  changes(space:string,after=0){return this.request<AnnotationPage>(`/api/annotations/spaces/${space}?after=${after}`);}
  mutate(space:string,operation:AnnotationOperation,actor?:string){return this.request<AnnotationRecord>(`/api/annotations/spaces/${space}`,'POST',operation,actor);}
  read(space:string,id:string){return this.request<AnnotationRecord>(`/api/annotations/spaces/${space}/${id}`);}
}
