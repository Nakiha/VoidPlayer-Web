import type {IncomingMessage,ServerResponse} from 'node:http';
import type {RouteContext} from '../../routes/context.ts';
import {requireCapturedActor} from '../../identity.ts';
import {AdminError,adminErrorBody} from '../../admin-error.ts';
import {adminWriteAllowed,readAdminJson} from '../../admin.ts';
import {sendJson} from '../../http-utils.ts';
import {REEXECUTION_LIMITS,reexecutionId} from '../../../shared/analysis/quality/reexecution.ts';
import type {ReexecutionKind} from '../../../shared/analysis/quality/reexecution.ts';

export async function handleQualityReexecutionRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
  const match=/^\/api\/quality\/(jobs|ranges|(?:vmaf|xpsnr|cambi)\/jobs)\/((?:(?:vmaf|xpsnr|cambi)-)?[a-f0-9-]{36})\/(reexecution-plan|reexecutions)$/.exec(url.pathname);
  if(!match)return false;
  const kind:ReexecutionKind=match[1]==='jobs'?'single':match[1]==='ranges'?'range':match[1]==='xpsnr/jobs'?'xpsnr':match[1]==='cambi/jobs'?'cambi':'vmaf',id=match[2];
  try{
    requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Select an identity first.','identity-required');
    if(!reexecutionId(kind,id))throw new AdminError(404,'Quality job not found.','job-not-found');
    if(url.search)throw new AdminError(400,'Reexecution uses no implicit cursor or request parameters.','invalid-request');
    const service=ctx.quality.qualityReexecutions;
    if(req.method==='GET'&&match[3]==='reexecutions'){sendJson(res,200,service.chain(kind,id,ctx.actor.id));return true;}
    if(req.method!=='POST')throw new AdminError(405,'Method not allowed.','method-not-allowed');
    if(!adminWriteAllowed(req,'quality-job'))throw new AdminError(403,'Use the same-origin quality-job action.','origin-required');
    const timer=setTimeout(()=>req.destroy(new Error('Reexecution body timeout')),10000),controller=new AbortController();
    const disconnect=()=>{if(!res.writableEnded)controller.abort(new AdminError(499,'Reexecution request disconnected before its response.','request-disconnected'));};res.once('close',disconnect);
    try{
      const body=await readAdminJson(req,REEXECUTION_LIMITS.requestBytes);clearTimeout(timer);
      if(match[3]==='reexecution-plan'){
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='reason'))throw new AdminError(400,'Planning accepts only an explicit reason.','invalid-reexecution-request');
        const plan=await service.plan(kind,id,ctx.actor.id,(body as {reason?:unknown}).reason,controller.signal);
        if(Buffer.byteLength(JSON.stringify(plan))>REEXECUTION_LIMITS.planBytes)throw new AdminError(413,'Reexecution plan response exceeds its metadata budget.','budget-exceeded');
        if(!res.destroyed)sendJson(res,200,plan);
      }else{
        const accepted=await service.execute(kind,id,ctx.actor,ctx.requestId,req.headers['idempotency-key'],body,controller.signal);
        res.setHeader('location',accepted.receipt?`/api/quality/${kind==='single'?'jobs':kind==='range'?'ranges':kind+'/jobs'}/${accepted.receipt.jobId}`:url.pathname);
        if(!res.destroyed)sendJson(res,accepted.replayed?200:202,accepted);
      }
    }finally{clearTimeout(timer);res.removeListener('close',disconnect);}
  }catch(error){if(!res.headersSent&&!res.destroyed){const e=error as {code?:string};sendJson(res,error instanceof AdminError?error.status:500,{...adminErrorBody(error),code:e.code??'reexecution-operation-failed',recovery:{automaticRetry:false,unknownSubmission:'replay-the-exact-original-actor-body-key-on-the-same-reexecution-endpoint',next:'read-the-original-chain-or-reexecution-plan'}});}}
  return true;
}
