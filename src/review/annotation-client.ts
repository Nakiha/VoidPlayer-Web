import { apiError } from '../services/api-error.ts';
import { currentActor } from '../services/identity.ts';
import type { AnnotationOperation, AnnotationPage, AnnotationRecord } from '../../shared/review/annotation-record.ts';
import { parseAnnotationOperation } from '../../shared/review/annotation-command.ts';
import type { AnnotationEventPage } from '../../shared/review/annotation-events.ts';
export class AnnotationClient {
  constructor(private signal: AbortSignal) {}
  async request<T>(url: string, method='GET', body?: unknown, actor=currentActor()?.id): Promise<T> {
    const response=await fetch(url,{method,cache:'no-store',headers:{...(actor?{'x-voidplayer-actor':actor}:{}),...(method==='GET'?{}:{'x-voidplayer-action':'annotation','content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([this.signal,AbortSignal.timeout(10000)])});
    const result=await response.json(); if(!response.ok)throw apiError(response.status, result);return result;
  }
  spaces(){return this.request<{id:string;name:string}[]>('/api/annotations/spaces');}
  createSpace(name:string){return this.request<{id:string;name:string}>('/api/annotations/spaces','POST',{name});}
  changes(space:string,after=0){return this.request<AnnotationPage>(`/api/annotations/spaces/${space}?after=${after}`);}
  mutate(space:string,operation:AnnotationOperation,actor?:string){return this.request<AnnotationRecord>(`/api/annotations/spaces/${space}`,'POST',parseAnnotationOperation(operation),actor);}
  events(space:string,after?:number){return this.request<AnnotationEventPage>(`/api/annotations/events/${space}${after===undefined?'':`?after=${after}`}`);}
  read(space:string,id:string){return this.request<AnnotationRecord>(`/api/annotations/spaces/${space}/${id}`);}
}
