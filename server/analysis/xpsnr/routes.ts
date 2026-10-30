import type {IncomingMessage,ServerResponse} from 'node:http';import type {RouteContext} from '../../routes/context.ts';
import {XpsnrError} from '../../../shared/analysis/quality/xpsnr.ts';
import {agentRecoveryFields} from '../../agent-errors.ts';
import {requireCapturedActor} from '../../identity.ts';import {AdminError,adminErrorBody} from '../../admin-error.ts';import {adminWriteAllowed,readAdminJson} from '../../admin.ts';import {sendJson} from '../../http-utils.ts';
export async function handleXpsnrRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
 if(!url.pathname.startsWith('/api/quality/xpsnr'))return false;
 try{
  if(url.pathname==='/api/quality/xpsnr/capability'&&req.method==='GET'){sendJson(res,200,await ctx.library.qualityXpsnr.capability());return true;}
  requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Choose an identity first.','identity-required');
  const service=ctx.library.qualityXpsnr,actor=ctx.actor;
  if(req.method!=='GET'&&!adminWriteAllowed(req,'quality-job'))throw new AdminError(403,'Use the same-origin quality-job action.','origin-required');
  const item=/^\/api\/quality\/xpsnr\/jobs\/(xpsnr-[a-f0-9-]{36})(?:\/(result|frames|cancel|candidates|evidence))?$/.exec(url.pathname),collection=url.pathname==='/api/quality/xpsnr/jobs',preflight=url.pathname==='/api/quality/xpsnr/preflight';
  const compare=url.pathname==='/api/quality/xpsnr/compare';
  const allowed=compare?['ids']:item?.[2]==='evidence'?['index','attemptId','digest','side']:req.method==='GET'&&(collection||item?.[2]==='frames')?['after','limit']:[];
  if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))throw new AdminError(400,'Invalid XPSNR query.','invalid-request');
  if(req.method==='GET'){
   if(compare){sendJson(res,200,service.compare((url.searchParams.get('ids')??'').split(','),actor.id));}
   else if(item?.[2]==='evidence'){const index=url.searchParams.get('index');if(!index||!/^\d{1,4}$/.test(index)||!['reference','distorted'].includes(url.searchParams.get('side')??''))throw new AdminError(400,'Invalid XPSNR evidence reference.','invalid-request');sendJson(res,200,service.evidence({jobId:item[1]+'-f'+index,attemptId:url.searchParams.get('attemptId')??'',digest:url.searchParams.get('digest')??'',side:url.searchParams.get('side') as 'reference'|'distorted'},actor.id));}
   else if(collection)sendJson(res,200,service.history(actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??8)));
   else if(item?.[2]==='result')sendJson(res,200,service.summary(item[1],actor.id));
   else if(item?.[2]==='frames')sendJson(res,200,service.frames(item[1],actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??4)));
   else if(item?.[2]==='candidates')sendJson(res,200,service.publication(item[1],actor.id));
   else if(item&&!item[2])sendJson(res,200,service.get(item[1],actor.id));
   else throw new AdminError(404,'XPSNR route not found.','xpsnr-not-found');return true;
  }
  if(req.method!=='POST'||!collection&&!preflight&&!['cancel','candidates'].includes(item?.[2]??''))throw new AdminError(405,'Method not allowed.','method-not-allowed');
  const timer=setTimeout(()=>req.destroy(Error('XPSNR body deadline')),10000);
  try{const body=await readAdminJson(req,16384);clearTimeout(timer);
   if(preflight){const controller=new AbortController(),abort=()=>controller.abort(new Error('Preflight observer disconnected'));res.once('close',abort);try{sendJson(res,200,await service.preflight(body,actor.id,controller.signal));}finally{res.off('close',abort);}}
   else if(collection){const value=service.submit(body,actor,ctx.requestId,req.headers['idempotency-key']);res.setHeader('location',`/api/quality/xpsnr/jobs/${value.job.id}`);sendJson(res,value.replayed?200:202,value);}
   else if(item![2]==='cancel'){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AdminError(400,'Cancellation needs an empty object.','invalid-request');sendJson(res,200,service.cancel(item![1],actor.id));}
   else{if(!ctx.options.admin)throw new AdminError(503,'Annotation storage unavailable.','storage-unavailable');sendJson(res,200,service.publish(item![1],actor,body,new URL(req.headers.origin!).origin,ctx.options.admin.annotations,ctx.requestId));}
  }finally{clearTimeout(timer);}
 }catch(error){if(!res.headersSent&&!res.destroyed)sendJson(res,error instanceof AdminError?error.status:error instanceof XpsnrError?(error.code==='component-unavailable'?503:400):500,{...adminErrorBody(error),code:(error as {code?:string}).code??'xpsnr-operation-failed',...agentRecoveryFields((error as {code?:string})?.code??'xpsnr-operation-failed','xpsnr.submit')});}
 return true;
}
