import {randomUUID} from 'node:crypto';
import {EXISTING_PATH} from './existing-pages.ts';
import type {StdioPageChannel} from './stdio.ts';

/** No redirect, DNS discovery, TLS exception, retries or owned server here. */
export class ExistingPageClient implements StdioPageChannel{
  client:{name:string;version:string}|null=null;clientRevision=0;ready=false;
  private stopped=false;
  private heartbeat?:ReturnType<typeof setInterval>;
  private calls=new Map<string,AbortController>();
  private chain=Promise.resolve();
  private constructor(private origin:string,private id:string,private secret:string){}
  static async create(value:string){
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Specify an exact loopback service origin, without credentials, path, query or fragment');
    const data=await ExistingPageClient.post(url.origin,'request',{});
    const channel=new ExistingPageClient(url.origin,data.id,data.secret);
    channel.heartbeat=setInterval(()=>{void channel.sync().catch(()=>channel.close());},1000);channel.heartbeat.unref();
    return {channel,pairingCode:data.pairingCode,expiresAt:data.expiresAt};
  }
  private static async post(origin:string,route:string,body:unknown,id?:string,secret?:string,signal?:AbortSignal){
    const response=await fetch(origin+EXISTING_PATH+'/'+route,{method:'POST',headers:{'content-type':'application/json',...(id?{'x-voidplayer-bridge-request':id,authorization:'Bearer '+secret}:{})},body:JSON.stringify(body),redirect:'error',signal:signal??AbortSignal.timeout(4000)});
    const reader=response.body!.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>128*1024){await reader.cancel();throw Error('channel-response-budget');}chunks.push(value);}}finally{reader.releaseLock();}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!response.ok)throw Error(value.code??'channel-unavailable');return value;
  }
  private post(route:string,body:unknown={},signal?:AbortSignal){if(this.stopped)return Promise.reject(Error('channel-closed'));return ExistingPageClient.post(this.origin,route,body,this.id,this.secret,signal);}
  sync(){const snapshot={client:this.client,revision:this.clientRevision,ready:this.ready};this.chain=this.chain.then(()=>this.post('sync',snapshot)).then(()=>{});return this.chain;}
  status(){return this.post('status');}
  receipt(operationId:unknown){return this.post('receipt',{operationId});}
  call(name:unknown,args:unknown,onCorrelation:(v:string)=>void){
    const callId=randomUUID(),controller=new AbortController();this.calls.set(callId,controller);onCorrelation(callId);
    return this.post('call',{callId,name,args},AbortSignal.any([controller.signal,AbortSignal.timeout(18000)])).catch(()=>({isError:true,code:'outcome-unknown',automaticReplay:false,reason:'service-connection-lost'})).finally(()=>this.calls.delete(callId));
  }
  cancel(correlation:string){this.calls.get(correlation)?.abort();}
  revoke(_reason:string){this.chain=this.chain.then(()=>this.post('revoke')).then(()=>{});}
  close(){if(this.stopped)return;clearInterval(this.heartbeat);for(const c of this.calls.values())c.abort();void this.post('close').catch(()=>{});this.stopped=true;}
}
