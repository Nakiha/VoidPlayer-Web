import type {IncomingMessage,ServerResponse} from 'node:http';
import type {RouteContext} from '../../routes/context.ts';
import {requireCapturedActor} from '../../identity.ts';
import {AdminError,adminErrorBody} from '../../admin-error.ts';
import {adminWriteAllowed,readAdminJson} from '../../admin.ts';
import {sendJson} from '../../http-utils.ts';
import {QUALITY_RANGE_LIMITS} from '../../../shared/analysis/quality/ranges.ts';
import {agentRecoveryFields} from '../../agent-errors.ts';

export async function handleQualityRangeRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
  if(!url.pathname.startsWith('/api/quality/ranges'))return false;
  try{
    requireCapturedActor(req,ctx.actor);
    if(!ctx.actor)throw new AdminError(401,'Select an identity first.','identity-required');
    if(req.method!=='GET'&&!adminWriteAllowed(req,'quality-job'))
      throw new AdminError(403,'Use the same-origin quality-job action.','origin-required');
    const ranges=ctx.library.qualityRanges,actor=ctx.actor;
    const item=/^\/api\/quality\/ranges\/([a-f0-9-]{36})(?:\/(results|cancel|candidates))?$/.exec(url.pathname);
    const collection=url.pathname==='/api/quality/ranges',plan=url.pathname==='/api/quality/ranges/plan';
    const allowedQuery=req.method==='GET'&&(collection||item?.[2]==='results')?['after','limit']:[];
    if([...url.searchParams.keys()].some(k=>!allowedQuery.includes(k)))
      throw new AdminError(400,'Unknown range query.','invalid-request');
    if(req.method==='GET'){
      if(collection)sendJson(res,200,{...ranges.list(actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??10)),limits:QUALITY_RANGE_LIMITS});
      else if(item&&item[2]==='results')sendJson(res,200,ranges.results(item[1],actor.id,Number(url.searchParams.get('after')??0),Number(url.searchParams.get('limit')??4)));
      else if(item&&!item[2]){const job=ranges.get(item[1],actor.id);sendJson(res,200,{job,coverage:ranges.coverage(job),progress:ranges.progress(job),publication:ranges.publication(job.id,actor.id)});}
      else if(item&&item[2]==='candidates')sendJson(res,200,ranges.publication(item[1],actor.id));
      else throw new AdminError(404,'Range route not found.','range-not-found');
      return true;
    }
    if(req.method!=='POST'||!collection&&!plan&&!item?.[2]||item?.[2]==='results')
      throw new AdminError(405,'Method not allowed.','method-not-allowed');
    const timer=setTimeout(()=>req.destroy(new Error('Range body timeout')),10000);
    try{
      const body=await readAdminJson(req,QUALITY_RANGE_LIMITS.requestBytes);clearTimeout(timer);
      if(plan)sendJson(res,200,ranges.plan(body));
      else if(collection){
        const accepted=ranges.submit(body,actor,ctx.requestId,req.headers['idempotency-key']);
        res.setHeader('location',`/api/quality/ranges/${accepted.job.id}`);sendJson(res,accepted.replayed?200:202,accepted);
      }else if(item![2]==='cancel'){
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)
          throw new AdminError(400,'Cancellation expects an empty object.','invalid-request');
        sendJson(res,200,ranges.cancel(item![1],actor.id));
      }else{
        if(!ctx.options.admin)throw new AdminError(503,'Annotation storage unavailable.','storage-unavailable');
        sendJson(res,200,ranges.publish(item![1],actor,body,new URL(req.headers.origin!).origin,ctx.options.admin.annotations,ctx.requestId));
      }
    }finally{clearTimeout(timer);}
  }catch(e){
    if(!res.headersSent&&!res.destroyed)sendJson(res,e instanceof AdminError?e.status:500,{...adminErrorBody(e),code:(e as {code?:string})?.code??'range-operation-failed',...agentRecoveryFields((e as {code?:string})?.code??'range-operation-failed','range.submit')});
  }
  return true;
}
