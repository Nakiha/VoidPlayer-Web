import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from '../../routes/context.ts';
import { adminWriteAllowed, readAdminJson } from '../../admin.ts';
import { AdminError, adminErrorBody } from '../../admin-error.ts';
import { sendJson } from '../../http-utils.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import { PsnrError } from '../../../shared/analysis/quality/psnr.ts';
import { libraryPairRequest } from './request.ts';


export async function handleQualityRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL) {
  const source=/^\/api\/media\/([a-f0-9]{24})\/(psnr-source|psnr-frames)$/.exec(url.pathname);
  if(!source&&url.pathname!=='/api/quality/psnr-pair')return false;
  const controller=new AbortController();
  const abort=()=>controller.abort(new AdminError(499,'One-shot quality request disconnected.','cancelled'));
  res.once('close',abort);
  try {
    if(!ctx.actor)throw new AdminError(401,'Select an intranet identity first.','identity-required');
    if(source){
      if(req.method!=='GET')throw new AdminError(405,'Method not allowed.');
      if([...url.searchParams.keys()].some(key=>!(source[2]==='psnr-source'?['v']:['v','afterAu','limit','buildId']).includes(key)))throw new AdminError(400,'Unexpected quality source parameters.','invalid-request');
      for(const key of ['afterAu','limit'])if(url.searchParams.has(key)&&!/^\d{1,9}$/.test(url.searchParams.get(key)!))throw new AdminError(400,'Invalid bounded frame query.','invalid-request');
      const version=url.searchParams.get('v')??'';
      const value=source[2]==='psnr-source'?await ctx.library.quality.source(source[1],version,controller.signal)
        :await ctx.library.quality.frames(source[1],version,{afterAu:Number(url.searchParams.get('afterAu')??0),limit:Number(url.searchParams.get('limit')??50),...(url.searchParams.has('buildId')?{buildId:url.searchParams.get('buildId')!}:{})},controller.signal);
      sendJson(res,200,value);return true;
    }
    if(req.method!=='POST')throw new AdminError(405,'Method not allowed.');
    if(url.search)throw new AdminError(400,'Unexpected quality query.','invalid-request');
    if(!adminWriteAllowed(req,'quality'))throw new AdminError(403,'Use the same-origin quality action.');
    const timer=setTimeout(()=>req.destroy(new Error('Quality request body timeout')),10000);
    try {
      const request=libraryPairRequest(await readAdminJson(req,16*1024));clearTimeout(timer);
      const value=await ctx.library.quality.measure(request,controller.signal);
      if(!res.destroyed)sendJson(res,200,{...value,request:{id:ctx.requestId,actorId:ctx.actor.id}});
    } finally {clearTimeout(timer);}
  } catch(error) {
    if(!res.destroyed&&!res.headersSent){
      const known=error instanceof AdminError||error instanceof FramePairError||error instanceof PsnrError;
      const e=error as Error&{code?:string};sendJson(res,error instanceof AdminError?error.status:e?.code==='budget-exceeded'?413:known?400:500,
        known?{...adminErrorBody(error),...(e.code?{code:e.code}:{})}:{error:'Quality execution failed.',code:'decoder-error'});
    }
  } finally {res.off('close',abort);}
  return true;
}
