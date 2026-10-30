import type {IncomingMessage,ServerResponse} from 'node:http';
import type {RouteContext} from '../../routes/context.ts';
import {requireCapturedActor} from '../../identity.ts';
import {AdminError,adminErrorBody} from '../../admin-error.ts';
import {adminWriteAllowed,readAdminJson} from '../../admin.ts';
import {sendJson} from '../../http-utils.ts';
import {CORRESPONDENCE_LIMITS} from '../../../shared/analysis/quality/correspondence.ts';
import {agentRecoveryFields} from '../../agent-errors.ts';

export async function handleCorrespondenceRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
  if(!/^\/api\/quality\/(reference-relations|correspondence-plans)(?:\/|$)/.test(url.pathname))return false;
  try{
    requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Select an identity first.','identity-required');
    if(req.method!=='GET'&&!adminWriteAllowed(req,'quality-job'))throw new AdminError(403,'Use the same-origin quality-job action.','origin-required');
    const match=/^\/api\/quality\/(reference-relations|correspondence-plans)(?:\/([a-f0-9-]{36})(?:\/(rows|range-input|execute|cancel))?)?$/.exec(url.pathname);
    if(!match)throw new AdminError(404,'Reference plan route not found.','plan-not-found');
    const [,kind,id,operation]=match,service=ctx.quality.qualityCorrespondence,actor=ctx.actor,relation=kind==='reference-relations';
    if(relation&&operation)throw new AdminError(404,'Relation operation not found.','relation-not-found');
    const allowed=req.method==='GET'&&(!id||operation==='rows')?['after','limit']:[];
    if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))throw new AdminError(400,'Unknown or repeated correspondence query.','invalid-request');
    const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??(operation==='rows'?32:10));
    if(req.method==='GET'){
      if(!id)sendJson(res,200,{...(relation?service.relations(actor.id,after,limit):service.history(actor.id,after,limit)),limits:CORRESPONDENCE_LIMITS});
      else if(relation)sendJson(res,200,service.relation(id,actor.id));
      else if(!operation)sendJson(res,200,service.detail(id,actor.id));
      else if(operation==='rows')sendJson(res,200,service.rows(id,actor.id,after,limit));
      else if(operation==='range-input')sendJson(res,200,service.rangeInput(id,actor.id));
      else throw new AdminError(405,'Method not allowed.','method-not-allowed');return true;
    }
    if(req.method!=='POST'||id&&!['execute','cancel'].includes(operation??''))throw new AdminError(405,'Method not allowed.','method-not-allowed');
    const timer=setTimeout(()=>req.destroy(new Error('Reference-plan body timeout')),10000);
    try{
      const body=await readAdminJson(req,CORRESPONDENCE_LIMITS.requestBytes);clearTimeout(timer);
      if(!id){const accepted=relation?service.createRelation(body,actor,ctx.requestId,req.headers['idempotency-key']):service.submit(body,actor,ctx.requestId,req.headers['idempotency-key']);sendJson(res,accepted.replayed?200:relation?201:202,accepted);}
      else if(operation==='execute'){const accepted=service.execute(id,actor,body,ctx.requestId);res.setHeader('location',`/api/quality/ranges/${accepted.job.id}`);sendJson(res,accepted.replayed?200:202,accepted);}
      else {if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AdminError(400,'Cancellation expects an empty object.','invalid-request');sendJson(res,200,service.cancel(id,actor.id));}
    }finally{clearTimeout(timer);}
  }catch(e){if(!res.headersSent&&!res.destroyed)sendJson(res,e instanceof AdminError?e.status:500,{...adminErrorBody(e),code:(e as {code?:string})?.code??'correspondence-failed',...agentRecoveryFields((e as {code?:string})?.code??'correspondence-failed','plan.create')});}
  return true;
}
