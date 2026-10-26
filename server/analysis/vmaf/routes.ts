import type {IncomingMessage,ServerResponse} from 'node:http';import type {RouteContext} from '../../routes/context.ts';
import {requireCapturedActor} from '../../identity.ts';import {AdminError,adminErrorBody} from '../../admin-error.ts';import {adminWriteAllowed,readAdminJson} from '../../admin.ts';import {sendJson} from '../../http-utils.ts';
export async function handleVmafRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
 if(!url.pathname.startsWith('/api/quality/vmaf'))return false;
 try{
  if(url.pathname==='/api/quality/vmaf/capability'&&req.method==='GET'){sendJson(res,200,await ctx.library.qualityVmaf.capability());return true;}
  requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Choose an identity first.','identity-required');
  const service=ctx.library.qualityVmaf,actor=ctx.actor;
  if(req.method!=='GET'&&!adminWriteAllowed(req,'quality-job'))throw new AdminError(403,'Use the same-origin quality-job action.','origin-required');
  const item=/^\/api\/quality\/vmaf\/jobs\/(vmaf-[a-f0-9-]{36})(?:\/(result|frames|cancel|candidates))?$/.exec(url.pathname),collection=url.pathname==='/api/quality/vmaf/jobs',preflight=url.pathname==='/api/quality/vmaf/preflight';
  const allowed=req.method==='GET'&&(collection||item?.[2]==='frames')?['after','limit']:[];
  if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))throw new AdminError(400,'Invalid VMAF query.','invalid-request');
  if(req.method==='GET'){
   if(collection)sendJson(res,200,service.history(actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??8)));
   else if(item?.[2]==='result')sendJson(res,200,service.summary(item[1],actor.id));
   else if(item?.[2]==='frames')sendJson(res,200,service.frames(item[1],actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??4)));
   else if(item?.[2]==='candidates')sendJson(res,200,service.publication(item[1],actor.id));
   else if(item&&!item[2])sendJson(res,200,service.get(item[1],actor.id));
   else throw new AdminError(404,'VMAF route not found.','vmaf-not-found');return true;
  }
  if(req.method!=='POST'||!collection&&!preflight&&!['cancel','candidates'].includes(item?.[2]??''))throw new AdminError(405,'Method not allowed.','method-not-allowed');
  const timer=setTimeout(()=>req.destroy(Error('VMAF body deadline')),10000);
  try{const body=await readAdminJson(req,16384);clearTimeout(timer);
   if(preflight){const controller=new AbortController(),abort=()=>controller.abort(new Error('Preflight observer disconnected'));res.once('close',abort);try{sendJson(res,200,await service.preflight(body,actor.id,controller.signal));}finally{res.off('close',abort);}}
   else if(collection){const value=service.submit(body,actor,ctx.requestId,req.headers['idempotency-key']);res.setHeader('location',`/api/quality/vmaf/jobs/${value.job.id}`);sendJson(res,value.replayed?200:202,value);}
   else if(item![2]==='cancel'){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AdminError(400,'Cancellation needs an empty object.','invalid-request');sendJson(res,200,service.cancel(item![1],actor.id));}
   else{if(!ctx.options.admin)throw new AdminError(503,'Annotation storage unavailable.','storage-unavailable');sendJson(res,200,service.publish(item![1],actor,body,new URL(req.headers.origin!).origin,ctx.options.admin.annotations,ctx.requestId));}
  }finally{clearTimeout(timer);}
 }catch(error){if(!res.headersSent&&!res.destroyed)sendJson(res,error instanceof AdminError?error.status:(error as {code?:string}).code==='component-unavailable'?503:400,{...adminErrorBody(error),code:(error as {code?:string}).code??'vmaf-operation-failed'});}
 return true;
}
