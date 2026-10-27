import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from '../routes/context.ts';
import { AdminError } from '../admin-error.ts';
import { adminWriteAllowed, readAdminJson } from '../admin.ts';
import { requireCapturedActor } from '../identity.ts';
import { sendJson } from '../http-utils.ts';
import {agentRecoveryFields} from '../agent-errors.ts';
import { DISCOVERY_DICTIONARY, DISCOVERY_PATH, PREPARATION_PATH, parseDiscoveryQuery } from '../../shared/media/discovery.ts';

export async function handleDiscoveryRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
  const detail=/^\/api\/media\/([0-9a-f]{24})\/discovery$/.exec(url.pathname);
  const job=/^\/api\/library\/preparations\/([a-f0-9-]{36})(?:\/(cancel))?$/.exec(url.pathname);
  const schema=url.pathname==='/api/library/discovery-schema',browse=url.pathname===DISCOVERY_PATH,collection=url.pathname===PREPARATION_PATH;
  if(!schema&&!browse&&!detail&&!job&&!collection)return false;
  const reply=(status:number,value:unknown)=>{if(!res.destroyed)sendJson(res,status,req.method==='HEAD'?undefined:value);};
  try{
    if(schema){if(!['GET','HEAD'].includes(req.method??''))throw new AdminError(405,'Read-only schema.','method-not-allowed');reply(200,DISCOVERY_DICTIONARY);return true;}
    if(browse||detail){if(!['GET','HEAD'].includes(req.method??''))throw new AdminError(405,'Read-only discovery.','method-not-allowed');
      if(browse){let query;try{query=parseDiscoveryQuery(url.searchParams);}catch(error){throw new AdminError(400,(error as Error).message,'invalid-discovery-query');}
        void ctx.library.discovery;
        const cancellation=new SharedArrayBuffer(4),cancel=()=>Atomics.store(new Int32Array(cancellation),0,1);res.once('close',cancel);
        try{reply(200,await ctx.library.indexJobs.call('discovery-browse',{query,cancellation}));}finally{res.off('close',cancel);}}
      else{if([...url.searchParams.keys()].some(k=>k!=='v')||url.searchParams.getAll('v').length!==1||!/^[a-f0-9]{24}$/.test(url.searchParams.get('v')??''))throw new AdminError(400,'Pin exactly one media version.','media-version-required');
        void ctx.library.discovery;
        const cancellation=new SharedArrayBuffer(4),cancel=()=>Atomics.store(new Int32Array(cancellation),0,1);res.once('close',cancel);
        try{reply(200,await ctx.library.indexJobs.call('discovery-detail',{source:{id:detail![1],version:url.searchParams.get('v')!},cancellation}));}finally{res.off('close',cancel);}}return true;}
    requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Select an intranet identity first.','identity-required');
    if(req.method==='GET'){
      if(job){if(job[2]||url.search)throw new AdminError(400,'Invalid preparation detail query.','invalid-preparation-query');reply(200,ctx.library.discovery.store.get(job[1],ctx.actor.id));}
      else{for(const k of url.searchParams.keys())if(!['before','limit'].includes(k)||url.searchParams.getAll(k).length!==1)throw new AdminError(400,'Invalid preparation page.','invalid-preparation-query');
        reply(200,ctx.library.discovery.store.list(ctx.actor.id,Number(url.searchParams.get('before')??0),Number(url.searchParams.get('limit')??32)));}return true;
    }
    if(req.method!=='POST'||job&&!job[2])throw new AdminError(405,'Method not allowed.','method-not-allowed');
    if(url.search)throw new AdminError(400,'Unexpected preparation query.','invalid-preparation-query');
    if(!adminWriteAllowed(req,'library-preparation'))throw new AdminError(403,'Use the same-origin library-preparation action.','origin-required');
    const timer=setTimeout(()=>req.destroy(new Error('Preparation request body deadline')),10000);
    try{const body=await readAdminJson(req,4096);clearTimeout(timer);
      if(collection){const value=ctx.library.discovery.submit(body,ctx.actor,ctx.requestId,req.headers['idempotency-key']);res.setHeader('location',`${PREPARATION_PATH}/${value.job.id}`);reply(value.replayed?200:202,value);}
      else{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AdminError(400,'Cancel body must be empty.','invalid-preparation-request');reply(200,ctx.library.discovery.cancel(job![1],ctx.actor.id));}
    }finally{clearTimeout(timer);}
  }catch(error){if(!res.destroyed&&!res.headersSent){const known=error instanceof AdminError,code=known?error.code:'discovery-failed',fields=agentRecoveryFields(code,collection?'library.prepare':job?'library.preparation':'library.describe');reply(known?error.status:500,{error:known?error.message:'Library discovery failed.',code,...fields,links:{...fields.links,describedBy:'/api/library/discovery-schema'}});}}
  return true;
}
