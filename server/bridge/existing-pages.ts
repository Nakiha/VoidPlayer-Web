import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {localRequest} from '../reveal.ts';
import {PageChannel} from './page-channel.ts';
import {BRIDGE_PATH,PAGE_BRIDGE_LIMITS as L} from '../../shared/service/page-bridge.ts';

export const EXISTING_PATH=BRIDGE_PATH+'/existing';
export const EXISTING_LIMITS={requests:4,pairMs:90000,grantMs:15*60*1000,leaseMs:5000};
type Entry={id:string;secret:string;code:string|null;document?:string;channel:PageChannel;expires:number;seen:number;revision:number};
const equal=(a:unknown,b:string)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-frame-options':'DENY','content-security-policy':"frame-ancestors 'none'"});res.end(JSON.stringify(value));};
/** Per-normal-server, memory only. Browser authority comes from a single-use
 * pairing capability and later a trusted page click, never an actor or Origin. */
export class ExistingPageRequests{
  private entries=new Map<string,Entry>();
  private documents=new Map<string,{origin:string;expires:number}>();
  private timer=setInterval(()=>{for(const [token,d]of this.documents)if(Date.now()>=d.expires)this.documents.delete(token);for(const e of this.entries.values())if(Date.now()>=e.expires||Date.now()-e.seen>=EXISTING_LIMITS.leaseMs)this.remove(e);},500);
  constructor(){this.timer.unref();}
  private remove(e:Entry){e.channel.close();this.entries.delete(e.id);e.code=null;}
  close(){clearInterval(this.timer);this.documents.clear();for(const e of this.entries.values())this.remove(e);}
  async handle(req:IncomingMessage,res:ServerResponse){
    const pathname=(req.url??'').split('?')[0];if(!pathname.startsWith(BRIDGE_PATH))return false;
    try{
      const socket=req.socket as typeof req.socket&{encrypted?:boolean};
      const origin=`${socket.encrypted?'https':'http'}://${req.headers.host}`;
      const target=new URL(origin);
      if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||!localRequest(req)||req.url?.includes('?')||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw Error('origin-host-denied');
      const browser=req.headers['sec-fetch-site']==='same-origin'&&(!req.headers.origin||req.headers.origin===origin);
      if(!pathname.startsWith(EXISTING_PATH+'/')){
        if(!browser)throw Error('origin-host-denied');
        const entry=this.entries.get(String(req.headers['x-voidplayer-bridge-request']??''));
        if(!entry||!entry.document||Date.now()>entry.expires)throw Error('authorization-revoked');
        if(pathname===BRIDGE_PATH+'/descriptor'&&!equal(req.headers.authorization,'Bearer '+entry.document))throw Error('document-credential-required');
        return await entry.channel.handle(req,res);
      }
      if(req.method!=='POST'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))throw Error('invalid-request');
      const chunks:Buffer[]=[];let size=0;const timeout=setTimeout(()=>req.destroy(),3000);
      try{for await(const chunk of req){size+=chunk.length;if(size>L.requestBytes)throw Error('message-budget');chunks.push(chunk);}}finally{clearTimeout(timeout);}
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid-request');
      const route=pathname.slice(EXISTING_PATH.length+1);
      if(route==='request'){
        if(browser||req.headers.origin||req.headers['sec-fetch-site']||Object.keys(body).length)throw Error('origin-host-denied');
        if(this.entries.size>=EXISTING_LIMITS.requests)throw Error('request-budget');
        const channel=new PageChannel('',true);channel.origin=origin;
        const e:Entry={id:randomBytes(16).toString('hex'),secret:randomBytes(32).toString('hex'),code:randomBytes(16).toString('hex'),channel,expires:Date.now()+EXISTING_LIMITS.pairMs,seen:Date.now(),revision:-1};
        this.entries.set(e.id,e);json(res,200,{id:e.id,secret:e.secret,pairingCode:e.code,expiresAt:e.expires,limits:EXISTING_LIMITS});return true;
      }
      if(route==='document'){
        if(!browser||req.headers.origin!==origin||req.headers['x-voidplayer-bridge']!=='1'||Object.keys(body).length)throw Error('origin-host-denied');
        if(this.documents.size>=8)throw Error('document-budget');
        const token=randomBytes(32).toString('hex');this.documents.set(token,{origin,expires:Date.now()+EXISTING_LIMITS.pairMs});
        json(res,200,{documentToken:token});return true;
      }
      if(route==='pair'){
        if(!browser||req.headers.origin!==origin||req.headers['x-voidplayer-bridge']!=='1'||Object.keys(body).some(k=>k!=='code')||typeof body.code!=='string')throw Error('origin-host-denied');
        const token=(req.headers.authorization??'').replace(/^Bearer /,'');const document=this.documents.get(token);
        if(!document||document.origin!==origin||Date.now()>=document.expires)throw Error('document-credential-required');
        const e=[...this.entries.values()].find(e=>e.code&&equal(body.code,e.code));
        if(!e||e.channel.origin!==origin||Date.now()>=e.expires||!e.channel.ready)throw Error('pairing-unavailable');
        this.documents.delete(token);e.code=null;e.document=e.channel.mintDocument(token);
        // A paired document gets a bounded window for explicit consent/use.
        e.expires=Date.now()+EXISTING_LIMITS.grantMs;
        json(res,200,{id:e.id,expiresAt:e.expires});return true;
      }
      if(browser||req.headers.origin||req.headers['sec-fetch-site'])throw Error('origin-host-denied');
      const e=this.entries.get(String(req.headers['x-voidplayer-bridge-request']??''));
      if(!e||e.channel.origin!==origin||Date.now()>=e.expires||!equal(req.headers.authorization,'Bearer '+e.secret))throw Error('authorization-revoked');
      e.seen=Date.now();
      if(route==='close'){this.remove(e);json(res,200,{closed:true});return true;}
      if(route==='sync'){
        if(!Number.isSafeInteger(body.revision)||typeof body.ready!=='boolean'||body.client!==null&&(!body.client||typeof body.client.name!=='string'||body.client.name.length>100||typeof body.client.version!=='string'||body.client.version.length>80))throw Error('invalid-request');
        if(body.revision===e.revision&&JSON.stringify(body.client)!==JSON.stringify(e.channel.client))throw Error('client-declaration-changed');
        if(body.revision<e.revision)throw Error('stale-client-revision');
        if(!body.ready)e.channel.revoke('client-not-ready');
        if(body.revision!==e.revision){e.channel.revoke('client-declaration-changed');e.revision=body.revision;}
        e.channel.client=body.client;e.channel.clientRevision=body.revision;e.channel.ready=body.ready;json(res,200,{synced:true});return true;
      }
      if(route==='status'){json(res,200,e.channel.status());return true;}
      if(route==='receipt'){json(res,200,e.channel.receipt(body.operationId));return true;}
      if(route==='revoke'){e.channel.revoke('stdio-revoked');json(res,200,{revoked:true});return true;}
      if(route==='cancel'){if(typeof body.correlation!=='string')throw Error('invalid-request');e.channel.cancel(body.correlation);json(res,200,{cancelled:true});return true;}
      if(route==='call'){
        // Correlation is returned only in the final result. Cancellation uses a
        // separate caller ID tracked below; no command can be issued by a page.
        if(typeof body.callId!=='string'||body.callId.length>80)throw Error('invalid-request');
        const result=await e.channel.call(body.name,body.args,correlation=>{res.once('close',()=>{if(!res.writableFinished)e.channel.cancel(correlation);});});
        json(res,200,result);return true;
      }
      throw Error('unknown-channel-route');
    }catch(error){if(!res.destroyed&&!res.headersSent)json(res,403,{isError:true,code:error instanceof Error&&/^[a-z-]+$/.test(error.message)?error.message:'invalid-request'});return true;}
  }
}
