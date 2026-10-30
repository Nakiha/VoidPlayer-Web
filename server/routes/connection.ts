import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_DOCUMENTS } from '../agent-guide.ts';
import { agentManifest, serviceCapabilities } from '../../shared/service/agent.ts';
import {agentTaskCatalog,agentTask,agentOperation,AGENT_TASK_CATALOG,AGENT_OPERATION_PATH} from '../../shared/service/agent-operations.ts';
import { agentErrorBody } from '../agent-errors.ts';
import { AdminError } from '../admin-error.ts';
import { connectionDetails } from '../connection-guide.ts';
import { encryptedRequest } from '../tls.ts';
import { localRequest } from '../reveal.ts';
import { sendJson } from '../http-utils.ts';
import type { RouteContext } from './context.ts';

/** Connection, discovery and health endpoints. Returns true when handled. */
export async function handleConnectionRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { options } = ctx;
  if (url.pathname === '/api/connection/probe' && req.method === 'GET') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    sendJson(res, encryptedRequest(req) ? 200 : 409, { service: 'voidplayer-connection', https: encryptedRequest(req) });
    return true;
  }
  if (url.pathname === '/api/connection' && req.method === 'GET') {
    sendJson(res, 200, connectionDetails(options.connection, req.headers.host));
    return true;
  }
  if (url.pathname === '/api/connection/certificate' && ['GET', 'HEAD'].includes(req.method ?? '')) {
    if (!options.connection?.ca) { sendJson(res, 404, { error: '当前服务没有可下载的本地根证书。' }); return true; }
    const certificate = Buffer.from(options.connection.ca);
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="voidplayer-ca.crt"', 'content-length': certificate.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : certificate);
    return true;
  }
  const document = AGENT_DOCUMENTS[url.pathname];
  const task=url.pathname.startsWith(AGENT_TASK_CATALOG+'/')?url.pathname.slice(AGENT_TASK_CATALOG.length+1):null;
  const operation=url.pathname.startsWith(AGENT_OPERATION_PATH)?url.pathname.slice(AGENT_OPERATION_PATH.length):null;
  const discovery=url.pathname==='/api/agent'||url.pathname===AGENT_TASK_CATALOG||task!==null||operation!==null;
  if (document !== undefined || discovery) {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      res.setHeader('allow', 'GET, HEAD'); sendJson(res, 405, agentErrorBody(new AdminError(405, 'read only', 'method-not-allowed'), ctx.requestId)); return true;
    }
    if(url.search){sendJson(res,400,agentErrorBody(new AdminError(400,'Discovery documents accept no query.','invalid-request'),ctx.requestId));return true;}
    const json = discovery;
    const manifest=()=>agentManifest({ capabilities: serviceCapabilities(!!options.admin, !!options.allowLocalReveal && localRequest(req)), libraryReady: ctx.library.ready, frontendAvailable: !!options.staticDir, localPageBridge:!!options.pageBridge||(localRequest(req)&&['127.0.0.1','localhost','[::1]'].includes(new URL('http://'+req.headers.host).hostname)),qualityJobsEnabled: ctx.library.durableQualityJobsEnabled, nativeVmaf:ctx.quality.nativeVmafDescriptor,nativeXpsnr:ctx.quality.nativeXpsnrDescriptor,nativeCambi:ctx.quality.nativeCambiDescriptor, actor: ctx.actor });
    const value=operation!==null?agentOperation(operation,manifest().capabilities):task!==null?agentTask(task):url.pathname===AGENT_TASK_CATALOG?agentTaskCatalog():json?manifest():null;
    if(json&&!value){sendJson(res,404,agentErrorBody(new AdminError(404,'Task or operation not found.','agent-operation-not-found'),ctx.requestId));return true;}
    const body = json ? JSON.stringify(value) : document!;
    const type = json ? 'application/json' : url.pathname === '/llms.txt' ? 'text/plain' : 'text/markdown';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': Buffer.byteLength(body), 'cache-control': json ? 'no-store' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (url.pathname === '/favicon.ico' && !options.staticDir && ['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(204); res.end(); return true; }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { service: 'voidplayer-media', version: 1, actor: ctx.actor, capabilities: serviceCapabilities(!!options.admin, !!options.allowLocalReveal && localRequest(req)) });
    return true;
  }
  if (url.pathname === '/api/ready' && req.method === 'GET') {
    sendJson(res, ctx.library.ready ? 200 : 503, { ready: ctx.library.ready });
    return true;
  }
  return false;
}
