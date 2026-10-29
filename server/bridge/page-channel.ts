import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {BRIDGE_PATH,PAGE_TOOLS,PAGE_BRIDGE_LIMITS as L,bridgeCallSchema,pageBridgeResult} from '../../shared/service/page-bridge.ts';
import type {PageCommand,PageScope,PageToolName} from '../../shared/service/page-bridge.ts';
import {validateToolInput} from '../../shared/service/tool-input.ts';
import {ISOLATION_HEADERS} from '../http-utils.ts';

type Grant={token:string;owner:string;epoch:string;context:string;workspace:string;scopes:PageScope[];seen:number};
type Fact={operationId:string;epoch:string;fingerprint:string;outcome:string;correlation:string;result?:unknown};
type Pending={command:PageCommand;dispatched:boolean;resolve:(v:unknown)=>void;timer:ReturnType<typeof setTimeout>;fact?:Fact};
const problem=(code:string,extra:object={})=>({isError:true,code,...extra});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fields(v:unknown,allowed:string[]){if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('invalid-request');return v;}
function text(v:unknown,max:number){if(typeof v!=='string'||!v.length||v.length>max)throw Error('invalid-request');return v;}
function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}

/** Only the launcher installs this channel on its own loopback page host.
 * Tokens are process/document-memory capabilities. Host/Origin are additional
 * web protections, never client identity or the channel credential. */
export class PageChannel {
  origin='';
  client:{name:string;version:string}|null=null;
  clientRevision=0;
  ready=false;
  private closed=false;
  private grant?:Grant;
  private pending=new Map<string,Pending>();
  private facts=new Map<string,Fact>();
  private documents=new Map<string,number>();
  private poll?:{res:ServerResponse;timer:ReturnType<typeof setTimeout>};
  private sweep:ReturnType<typeof setInterval>;
  private html:string;
  private optionalRead:boolean;
  constructor(html:string,optionalRead=false){
    this.optionalRead=optionalRead;
    this.html=html;
    this.sweep=setInterval(()=>{if(this.grant&&Date.now()-this.grant.seen>L.leaseMs)this.revoke('page-lease-expired');for(const [key,seen] of this.documents)if(Date.now()-seen>300000&&this.grant?.owner!==key)this.documents.delete(key);},500);this.sweep.unref();
  }
  mintDocument(){const token=randomBytes(32).toString('hex');this.documents.set(token,Date.now());return token;}
  status(){const g=this.grant;return {schema:'voidplayer-page-bridge',version:1,connected:!!g,clientClaim:this.client,clientIdentity:'self-declared-not-authenticated',...(g?{epoch:g.epoch,workspace:g.scopes.includes('read')?g.workspace:g.context,scopes:g.scopes}:{}),limits:L,next:g?'Use this exact epoch. Never replay unknown writes.':'Open the intended page and explicitly connect; no page is followed automatically.'};}
  receipt(operationId:unknown){const f=this.facts.get(text(operationId,80));return f?{operationId:f.operationId,epoch:f.epoch,outcome:f.outcome,correlation:f.correlation,automaticReplay:false}:{operationId,outcome:'not-recorded',automaticReplay:false,next:'Receipt absence is not proof of no effect. Inspect the original page; never automatically replay.'};}
  private credential(req:IncomingMessage){const value=req.headers.authorization??'',g=this.grant;if(!g||!/^Bearer [a-f0-9]{64}$/.test(value)||!timingSafeEqual(Buffer.from(value.slice(7),'hex'),Buffer.from(g.token,'hex')))throw Error('authorization-revoked');return g;}
  private finish(p:Pending,result:unknown,outcome:string){
    if(!this.pending.delete(p.command.correlation))return;
    clearTimeout(p.timer);
    if(p.fact){p.fact.outcome=outcome;if(outcome==='completed')p.fact.result=result;}
    p.resolve(result);this.flush();
  }
  revoke(reason:string){
    this.grant=undefined;
    if(this.poll){clearTimeout(this.poll.timer);const {res}=this.poll;this.poll=undefined;if(!res.destroyed)json(res,403,problem('authorization-revoked'));}
    for(const p of [...this.pending.values()])this.finish(p,problem(p.dispatched?'outcome-unknown':'not-executed',{reason,epoch:p.command.epoch,correlation:p.command.correlation,operationId:p.command.operationId??null,automaticReplay:false}),p.dispatched?'unknown':'not-executed');
  }
  cancel(correlation:string){const p=this.pending.get(correlation);if(p){if(p.dispatched)this.revoke('request-cancelled-after-dispatch');else this.finish(p,problem('not-executed',{correlation,automaticReplay:false}),'not-executed');}}
  call(name:unknown,args:unknown,onCorrelation:(v:string)=>void):Promise<unknown>{
    if(typeof name!=='string'||!Object.hasOwn(PAGE_TOOLS,name))return Promise.resolve(problem('unknown-tool'));
    const key=name as PageToolName;
    try{validateToolInput(bridgeCallSchema(key),args);}catch{return Promise.resolve(problem('invalid-arguments'));}
    const a=args as {epoch:string;operationId?:string;input:unknown},g=this.grant;
    if(!g||a.epoch!==g.epoch)return Promise.resolve(problem('host-unavailable',{next:'Explicitly connect the intended page and obtain its new epoch.'}));
    if(!g.scopes.includes(PAGE_TOOLS[key].scope))return Promise.resolve(problem('scope-denied'));
    const fingerprint=createHash('sha256').update(JSON.stringify([key,a.epoch,a.input])).digest('hex');
    const prior=a.operationId?this.facts.get(a.operationId):null;
    if(prior)return Promise.resolve(prior.fingerprint!==fingerprint?problem('operation-conflict'):prior.outcome==='completed'?prior.result:problem(prior.outcome==='not-executed'?'not-executed':'outcome-unknown',{...this.receipt(a.operationId)}));
    if(this.pending.size>=L.queued)return Promise.resolve(problem('queue-full'));
    if(PAGE_TOOLS[key].scope!=='read'&&this.facts.size>=L.receipts)return Promise.resolve(problem('receipt-budget-full'));
    const correlation=randomUUID(),command:PageCommand={correlation,epoch:g.epoch,name:key,input:a.input,...(a.operationId?{operationId:a.operationId}:{})};
    onCorrelation(correlation);
    return new Promise(resolve=>{
      const fact=a.operationId?{operationId:a.operationId,epoch:g.epoch,correlation,fingerprint,outcome:'queued'}:undefined;
      if(fact)this.facts.set(fact.operationId,fact);
      const p:Pending={command,dispatched:false,resolve,fact,timer:setTimeout(()=>{if(p.dispatched)this.revoke('request-deadline-after-dispatch');else this.finish(p,problem('not-executed',{correlation,operationId:a.operationId??null,reason:'queue-deadline',automaticReplay:false}),'not-executed');},L.timeoutMs)};
      this.pending.set(correlation,p);this.flush();
    });
  }
  private flush(){
    if(!this.poll||!this.grant||[...this.pending.values()].some(p=>p.dispatched))return;
    const p=[...this.pending.values()].find(p=>!p.dispatched);if(!p)return;
    p.dispatched=true;if(p.fact)p.fact.outcome='dispatched';
    const {res,timer}=this.poll;this.poll=undefined;clearTimeout(timer);json(res,200,{command:p.command});
  }
  async handle(req:IncomingMessage,res:ServerResponse){
    // Guard every route on this dedicated host, including static/bootstrap.
    if(!this.origin||req.headers.host!==new URL(this.origin).host||req.headers.origin&&req.headers.origin!==this.origin||req.headers['sec-fetch-site']==='cross-site'){
      json(res,403,problem('origin-host-denied'));return true;
    }
    res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    const url=new URL(req.url??'/',this.origin);
    if((req.method==='GET'||req.method==='HEAD')&&url.pathname==='/'){
      if(this.documents.size>=8){json(res,429,problem('document-budget'));return true;}
      const bootstrap=randomBytes(32).toString('hex');if(req.method==='GET')this.documents.set(bootstrap,Date.now());
      for(const [k,v]of Object.entries(ISOLATION_HEADERS))res.setHeader(k,v);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      const html=this.html.replace('<head>',`<head><meta name="voidplayer-page-bridge" content="${bootstrap}">`);res.end(req.method==='HEAD'?'':html);return true;
    }
    if(!url.pathname.startsWith(BRIDGE_PATH))return false;
    try{
      if(this.closed)throw Error('host-unavailable');
      if(url.search)throw Error('invalid-request');
      if(url.pathname===BRIDGE_PATH+'/descriptor'&&req.method==='GET'){json(res,200,{enabled:true,ready:this.ready,clientClaim:this.client,clientRevision:this.clientRevision,clientIdentity:'self-declared-not-authenticated',limits:L,tools:Object.entries(PAGE_TOOLS).map(([name,d])=>({name,scope:d.scope}))});return true;}
      if(req.method!=='POST'){json(res,405,problem('method-not-allowed'));return true;}
      if(req.headers.origin!==this.origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['x-voidplayer-bridge']!=='1'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Error('origin-host-denied');
      const timeout=setTimeout(()=>req.destroy(),3000);const chunks:Buffer[]=[];
      try{let size=0;for await(const data of req){size+=data.length;if(size>L.requestBytes)throw Error('message-budget');chunks.push(data);}}finally{clearTimeout(timeout);}
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const body=fields(JSON.parse(raw),url.pathname.endsWith('/connect')?['context','workspace','scopes','clientRevision']:url.pathname.endsWith('/reply')?['epoch','correlation','result']:['epoch']);
      if(url.pathname===BRIDGE_PATH+'/connect'){
        const owner=(req.headers.authorization??'').replace(/^Bearer /,'');if(!this.documents.has(owner))throw Error('document-credential-required');
        if(!this.ready||!this.client)throw Error('client-not-ready');
        if(body.clientRevision!==this.clientRevision)throw Error('client-declaration-changed');
        if(this.grant)throw Error('page-already-connected');
        if(!Array.isArray(body.scopes)||body.scopes.length>3||!body.scopes.length||!this.optionalRead&&!body.scopes.includes('read')||new Set(body.scopes).size!==body.scopes.length||body.scopes.some(s=>!['read','view','annotate'].includes(s)))throw Error('invalid-scopes');
        this.documents.set(owner,Date.now());this.grant={token:randomBytes(32).toString('hex'),owner,epoch:randomUUID(),context:text(body.context,200),workspace:text(body.workspace,300),scopes:body.scopes as PageScope[],seen:Date.now()};
        json(res,200,{token:this.grant.token,epoch:this.grant.epoch});return true;
      }
      if(url.pathname===BRIDGE_PATH+'/retire'){
        const owner=(req.headers.authorization??'').replace(/^Bearer /,'');if(!this.documents.delete(owner))throw Error('document-credential-required');
        if(this.grant?.owner===owner)this.revoke('document-closed');json(res,200,{retired:true});return true;
      }
      const g=this.credential(req);if(body.epoch!==g.epoch)throw Error('authorization-revoked');
      if(url.pathname===BRIDGE_PATH+'/revoke'){this.revoke('page-revoked');json(res,200,{revoked:true});return true;}
      if(url.pathname===BRIDGE_PATH+'/reply'){
        if(!Object.hasOwn(body,'result'))throw Error('invalid-request');
        const p=this.pending.get(text(body.correlation,80));
        if(!p||p.command.epoch!==g.epoch||!p.dispatched)throw Error('stale-correlation');
        g.seen=Date.now();
        if(Buffer.byteLength(JSON.stringify(body.result)??'')>L.resultBytes){this.finish(p,problem('outcome-unknown',{correlation:p.command.correlation,operationId:p.command.operationId??null,reason:'result-budget',automaticReplay:false}),'unknown');}
        else this.finish(p,pageBridgeResult(p.command.name,body.result,g.scopes),'completed');
        json(res,200,{accepted:true});return true;
      }
      if(url.pathname===BRIDGE_PATH+'/poll'){
        if(this.poll)throw Error('duplicate-poll');
        g.seen=Date.now();
        const timer=setTimeout(()=>{if(this.poll?.res===res){this.poll=undefined;json(res,200,{command:null});}},L.pollMs);
        this.poll={res,timer};
        res.once('close',()=>{if(!res.writableFinished&&this.grant?.epoch===g.epoch)this.revoke('page-channel-disconnected');});
        this.flush();return true;
      }
      throw Error('unknown-channel-route');
    }catch(e){const code=e instanceof Error&&/^[a-z-]+$/.test(e.message)?e.message:'invalid-request';if(!res.headersSent&&!res.destroyed)json(res,['authorization-revoked','document-credential-required','origin-host-denied'].includes(code)?403:400,problem(code));return true;}
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.sweep);this.revoke('stdio-closed');this.documents.clear();}
}
