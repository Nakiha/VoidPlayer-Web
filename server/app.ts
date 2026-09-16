import { randomUUID } from 'node:crypto';
import { guestActor, browserUserId } from './identity.ts';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { ServerOptions as HttpsOptions } from 'node:https';
import { encryptedRequest } from './tls.ts';
import type { ConnectionOptions } from './connection-guide.ts';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localRequest, setClientAddress } from './reveal.ts';
import { MediaLibraryIndex } from './library.ts';
import type { AdminController } from './admin.ts';
import { ISOLATION_HEADERS, sendJson, serveFile } from './http-utils.ts';
import { handleConnectionRoutes } from './routes/connection.ts';
import { handleStateRoutes } from './routes/state.ts';
import { handleContentRoutes } from './routes/content.ts';
import type { RouteContext } from './routes/context.ts';

// Narrow read-only HTTP API for the web player:
//   GET /api/library        -> media list under the whitelisted folders
//   GET|HEAD /api/media/<id> -> file bytes with HTTP Range support
// plus static hosting of the built frontend (dist/) when present.

export function createTrafficState() { return { sockets:new Set<import('node:net').Socket>(),activeRequests:0,completedRequests:0,abortedRequests:0,recentRequests:[] as Record<string,unknown>[] }; }

export interface ServerOptions {
  traffic?: ReturnType<typeof createTrafficState>;
  roots: string[];
  tls?: HttpsOptions;
  connection?: ConnectionOptions;
  clientAddress?: (req: IncomingMessage) => string;
  library?: MediaLibraryIndex;
  admin?: AdminController;
  allowLocalReveal?: boolean;
  reveal?: (absolutePath: string) => Promise<void>;
  staticDir?: string;
  /** Directory that receives user-submitted logs (POST /api/logs). */
  logsDir?: string;
  onLog?: (entry: Record<string, unknown>) => void;
}

export function createMediaServer(options: ServerOptions): Server {
  const roots = options.roots.map(r => path.resolve(r));
  const library = options.library ?? new MediaLibraryIndex(roots);
  if (!options.library) library.start();
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : undefined;
  const staticRoot = staticDir ? fs.realpath(staticDir).catch(() => null) : Promise.resolve(null);
  const logLine = options.onLog ?? (entry => console.log(JSON.stringify(entry)));
  const traffic=options.traffic ?? createTrafficState();
  const {sockets,recentRequests}=traffic;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    if(options.clientAddress)setClientAddress(req,options.clientAddress(req));
    const started = performance.now();
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('link', '</llms.txt>; rel="describedby"; type="text/plain"');
    let hostname = '';
    try { hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname; } catch {}
    if (encryptedRequest(req) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname)) {
      for (const [key, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(key, value);
    }
    let logged = false;
    traffic.activeRequests++;
    const ctx: RouteContext = {
      options, library, requestId,
      actor: guestActor(browserUserId(req)) ?? options.admin?.workspaces.user(browserUserId(req)) ?? null,
      adminExtra: { traffic, sockets, recentRequests },
    };
    const finish = () => {
      if (logged) return; logged = true;
      traffic.activeRequests--; traffic.completedRequests++; if (!res.writableFinished) traffic.abortedRequests++;
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/api/health' || pathname === '/api/ready') return;
      const entry = { t: new Date().toISOString(), requestId, actorId: ctx.actor?.id ?? (localRequest(req) ? 'local' : null), method: req.method, url: pathname, status: res.statusCode, completed: res.writableFinished, ms: Math.round(performance.now() - started) };
      logLine(entry);
      if (!pathname.startsWith('/api/admin/') || req.method !== 'GET') { recentRequests.push(entry); if (recentRequests.length > 200) recentRequests.shift(); }
    };
    res.once('finish', finish); res.once('close', finish);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (await handleConnectionRoutes(ctx, req, res, url)) return;
      if (await handleStateRoutes(ctx, req, res, url)) return;
      if (await handleContentRoutes(ctx, req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'read only' }); return;
      }
      if (staticDir) {
        const rel = decodeURIComponent(['/', '/connection'].includes(url.pathname) ? '/index.html' : ['/admin', '/admin/'].includes(url.pathname) ? '/admin/index.html' : url.pathname);
        const root = await staticRoot;
        const candidate = root ? path.join(root, rel) : '';
        const real = await fs.realpath(candidate).catch(() => null);
        if (root && real && (real === root || real.startsWith(root + path.sep)) && (await fs.stat(real)).isFile()) {
          await serveFile(req, res, real);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  };
  const server = options.tls ? createSecureServer(options.tls, handleRequest) : createServer(handleRequest);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  if (!options.library) server.on('close', () => { void library.close(); });
  return server;
}
