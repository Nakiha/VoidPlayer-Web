import type {IncomingMessage,ServerResponse} from 'node:http';
import type {RouteContext} from '../routes/context.ts';
import {AdminError} from '../admin-error.ts';
import {adminWriteAllowed,readAdminJson} from '../admin.ts';
import {requireCapturedActor} from '../identity.ts';
import {sendJson} from '../http-utils.ts';
import {TASK_KINDS,taskQuery} from '../../shared/service/tasks.ts';
import type {TaskKind} from '../../shared/service/tasks.ts';

export async function handleTaskRoutes(ctx:RouteContext,req:IncomingMessage,res:ServerResponse,url:URL){
  if(url.pathname!=='/api/tasks'&&!url.pathname.startsWith('/api/tasks/'))return false;
  const reply=(status:number,value:unknown)=>sendJson(res,status,req.method==='HEAD'?undefined:value);
  try{
    requireCapturedActor(req,ctx.actor);if(!ctx.actor)throw new AdminError(401,'Select a service identity.','identity-required');
    const match=/^\/api\/tasks\/([a-z]+)\/(vmaf-[a-f0-9-]{36}|[a-f0-9-]{36})(?:\/(cancel))?$/.exec(url.pathname);
    const collection=url.pathname==='/api/tasks';
    if(!collection&&(!match||!TASK_KINDS.includes(match[1] as TaskKind)))throw new AdminError(404,'Task route not found.','task-not-found');
    const kind=match?.[1] as TaskKind,id=match?.[2]??'';
    if(req.method==='GET'||req.method==='HEAD'){
      if(match?.[3])throw new AdminError(405,'Cancel requires an explicit POST.','method-not-allowed');
      if(collection){let query;try{query=taskQuery(url.searchParams);}catch(e){throw new AdminError(400,(e as Error).message,'invalid-task-query');}reply(200,ctx.library.tasks.query(ctx.actor.id,query));}
      else{if(url.search)throw new AdminError(400,'Task detail takes no query.','invalid-task-query');reply(200,ctx.library.tasks.detail(kind,id,ctx.actor.id));}return true;
    }
    if(req.method!=='POST'||!match?.[3])throw new AdminError(405,'Method not allowed.','method-not-allowed');
    if(url.search)throw new AdminError(400,'Cancel takes no query.','invalid-task-query');
    const action=kind==='preparation'?'library-preparation':'quality-job';
    if(!adminWriteAllowed(req,action))throw new AdminError(403,'Use the same-origin task cancellation action.','origin-required');
    const timer=setTimeout(()=>req.destroy(new Error('Task cancel body timeout')),10000);
    try{const body=await readAdminJson(req,256);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AdminError(400,'Cancel requires an empty object.','invalid-task-cancel');reply(200,ctx.library.tasks.cancel(kind,id,ctx.actor.id,ctx.requestId));}finally{clearTimeout(timer);}
  }catch(e){if(!res.headersSent&&!res.destroyed)reply(e instanceof AdminError?e.status:500,{error:e instanceof AdminError?e.message:'Task center request failed.',code:e instanceof AdminError?e.code:'task-center-failed',recovery:(e as {code?:string})?.code==='task-cursor-expired'?'Restart GET /api/tasks without cursor, retaining the same filters and selected target.':null,links:{collection:'/api/tasks',guide:'/agent/quality/tasks.md'}});}
  return true;
}
