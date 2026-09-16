import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_GUIDE } from '../agent-guide.ts';
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
  if (url.pathname === '/llms.txt') {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      res.setHeader('allow', 'GET, HEAD'); sendJson(res, 405, { error: 'read only' }); return true;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(AGENT_GUIDE), 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : AGENT_GUIDE);
    return true;
  }
  if (url.pathname === '/favicon.ico' && ['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(204); res.end(); return true; }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { service: 'voidplayer-media', version: 1, actor: ctx.actor, capabilities: { admin: !!options.admin, workspaces: !!options.admin, annotations: !!options.admin, reveal: !!options.allowLocalReveal && localRequest(req) } });
    return true;
  }
  if (url.pathname === '/api/ready' && req.method === 'GET') {
    sendJson(res, ctx.library.ready ? 200 : 503, { ready: ctx.library.ready });
    return true;
  }
  return false;
}
