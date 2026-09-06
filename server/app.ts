import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { requestActor } from './identity.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allowReveal, localRequest, revealFile } from './reveal.ts';
import { MediaLibraryIndex, fileVersion } from './library.ts';
import { AdminError, adminIdentity, adminWriteAllowed, readAdminJson } from './admin.ts';
import type { AdminController } from './admin.ts';

// Narrow read-only HTTP API for the web player:
//   GET /api/library        -> media list under the whitelisted folders
//   GET|HEAD /api/media/<id> -> file bytes with HTTP Range support
// plus static hosting of the built frontend (dist/) when present.

export interface ServerOptions {
  roots: string[];
  proxyToken?: string;
  library?: MediaLibraryIndex;
  admin?: AdminController;
  allowLocalReveal?: boolean;
  reveal?: (absolutePath: string) => Promise<void>;
  staticDir?: string;
  /** Directory that receives user-submitted logs (POST /api/logs). */
  logsDir?: string;
  onLog?: (entry: Record<string, unknown>) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.flv': 'video/x-flv', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...ISOLATION_HEADERS });
  res.end(payload);
}

// Cross-origin isolation headers enable SharedArrayBuffer for the
// multi-threaded WASM decoder core. Everything we serve is same-origin, so
// require-corp is safe here.
const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'unsatisfiable';
  let start: number, end: number;
  if (match[1] === '') { // suffix: last N bytes
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return 'unsatisfiable';
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, absPath: string, contentType?: string, expectedVersion?: string) {
  const handle = await fs.open(absPath, 'r').catch(() => null);
  if (!handle) { sendJson(res, 404, { error: 'not found' }); return; }
  try {
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
    if (expectedVersion && fileVersion(stat) !== expectedVersion) { sendJson(res, 409, { error: '媒体内容已改变，请重新载入。' }); return; }
    const size = stat.size;
    const type = contentType ?? MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...ISOLATION_HEADERS };
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      ...base,
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    if (size === 0) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}

export function createMediaServer(options: ServerOptions): Server {
  const roots = options.roots.map(r => path.resolve(r));
  const library = options.library ?? new MediaLibraryIndex(roots);
  if (!options.library) library.start();
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : undefined;
  const staticRoot = staticDir ? fs.realpath(staticDir).catch(() => null) : Promise.resolve(null);
  const logLine = options.onLog ?? (entry => console.log(JSON.stringify(entry)));
  const sockets = new Set<import('node:net').Socket>();
  let activeRequests = 0, completedRequests = 0, abortedRequests = 0;
  const recentRequests: Record<string, unknown>[] = [];

  const server = createServer(async (req, res) => {
    const started = performance.now();
    const actor = requestActor(req, options.proxyToken);
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    let status = 200, logged = false;
    activeRequests++;
    const finish = () => {
      if (logged) return; logged = true;
      activeRequests--; completedRequests++; if (!res.writableFinished) abortedRequests++;
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/api/health' || pathname === '/api/ready') return;
      const entry = { t: new Date().toISOString(), requestId, actorId: actor?.id ?? (localRequest(req) ? 'local' : null), method: req.method, url: pathname, status: res.statusCode, completed: res.writableFinished, ms: Math.round(performance.now() - started) };
      logLine(entry);
      if (!pathname.startsWith('/api/admin/') || req.method !== 'GET') { recentRequests.push(entry); if (recentRequests.length > 200) recentRequests.shift(); }
    };
    res.once('finish', finish); res.once('close', finish);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const healthRequest = ['/api/health', '/api/ready'].includes(url.pathname) && req.method === 'GET';
      if (options.proxyToken && !actor && !healthRequest) { status = 401; sendJson(res, 401, { error: '请通过团队登录入口访问。' }); return; }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { service: 'voidplayer-media', version: 1, actor, capabilities: { admin: !!options.admin, reveal: !!options.allowLocalReveal && localRequest(req) } });
        return;
      }
      if (url.pathname === '/api/ready' && req.method === 'GET') {
        status = library.ready ? 200 : 503; sendJson(res, status, { ready: library.ready }); return;
      }
      if (url.pathname.startsWith('/api/admin/')) {
        const admin = options.admin;
        if (!admin) { sendJson(res, 404, { error: '此服务尚未提供管理后台。' }); return; }
        const identity = adminIdentity(req, options.proxyToken, admin.config.adminUsers);
        if (!identity) { sendJson(res, 403, { error: options.proxyToken ? '当前网关用户没有管理权限，请在服务器配置的 adminUsers 中授权。' : '管理后台仅接受本机访问，远端请配置认证网关与管理员身份。' }); return; }
        if (req.method !== 'GET' && !adminWriteAllowed(req, options.proxyToken)) { sendJson(res, 403, { error: '管理操作必须由同源页面发起。' }); return; }
        try {
          if (url.pathname === '/api/admin/status' && req.method === 'GET') {
            sendJson(res, 200, { ...admin.status(), identity, http: { activeRequests, connections: sockets.size, completedRequests, abortedRequests }, recentRequests }); return;
          }
          if (url.pathname === '/api/admin/roots') {
            if (req.method === 'GET') { sendJson(res, 200, await admin.roots()); return; }
            if (req.method === 'PUT') { sendJson(res, 200, await admin.saveRoots(await readAdminJson(req))); return; }
          }
          if (url.pathname === '/api/admin/scan') {
            if (req.method === 'GET') {
              const offset = Number(url.searchParams.get('offset') ?? 0);
              if (!Number.isSafeInteger(offset) || offset < 0) throw new AdminError(400, '错误分页位置无效。');
              sendJson(res, 200, { ...library.status(), errors: library.errors(100, offset), offset }); return;
            }
            if (req.method === 'POST') {
              const body = await readAdminJson(req) as { action?: unknown } | null;
              if (body?.action === 'refresh') void library.refresh().catch(() => {});
              else if (body?.action === 'cancel') library.cancel();
              else throw new AdminError(400, '未知扫描操作。');
              sendJson(res, 202, library.status()); return;
            }
          }
          if (url.pathname === '/api/admin/logs' && req.method === 'GET') { sendJson(res, 200, await admin.logs(url.searchParams.get('before') ?? '')); return; }
          const log = /^\/api\/admin\/logs\/([^/]+)$/.exec(url.pathname);
          if (log) {
            const name = decodeURIComponent(log[1]);
            if (req.method === 'GET') { sendJson(res, 200, await admin.readLog(name, url.searchParams.get('v'))); return; }
            if (req.method === 'DELETE') { sendJson(res, 200, await admin.deleteLog(name, typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : null)); return; }
          }
          sendJson(res, 405, { error: '不支持的管理操作。' }); return;
        } catch (error) { sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); return; }
      }
      if (url.pathname === '/api/library/scan' && req.method === 'GET') {
        sendJson(res, 200, { ...library.status(), errors: library.errors() }); return;
      }
      if (url.pathname === '/api/library/scan' && req.method === 'POST') {
        let sameOrigin = false;
        try { const origin = new URL(req.headers.origin ?? ''); sameOrigin = origin.host === req.headers.host && origin.protocol === `${options.proxyToken ? req.headers['x-forwarded-proto'] ?? 'https' : 'http'}:`; } catch {}
        if (!sameOrigin || req.headers['x-voidplayer-action'] !== 'scan') { sendJson(res, 403, { error: '请从播放器或管理页面操作扫描。' }); return; }
        if (url.searchParams.get('action') === 'cancel') library.cancel();
        else if (!url.searchParams.has('action') || url.searchParams.get('action') === 'refresh') void library.refresh().catch(() => {});
        else { sendJson(res, 400, { error: '未知扫描操作。' }); return; }
        sendJson(res, 202, library.status()); return;
      }
      if (url.pathname === '/api/library/browse' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) { sendJson(res, 400, { error: '无效分页参数。' }); return; }
        const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) { sendJson(res, 400, { error: '无效版本参数。' }); return; }
        try { sendJson(res, 200, library.browse({ rootId: url.searchParams.get('root') || undefined, directory: url.searchParams.get('directory') ?? '', search: url.searchParams.get('search') ?? '', recursive: url.searchParams.get('recursive') === '1', limit, offset, revision })); }
        catch (error) { sendJson(res, (error as {code?: string}).code === 'INDEX_CHANGED' ? 409 : 400, { error: (error as Error).message }); }
        return;
      }
      const actionMatch = /^\/api\/media\/([0-9a-f]{24})\/(location|reveal|metadata)$/.exec(url.pathname);
      if (actionMatch) {
        const action = actionMatch[2];
        if (action === 'metadata') {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
          const entry = library.metadata(actionMatch[1]);
          sendJson(res, entry ? 200 : 404, entry ?? { error: 'unknown media id' }); return;
        }
        if (action === 'reveal' && (req.method !== 'POST' || !options.allowLocalReveal || !allowReveal(req))) {
          status = 403; sendJson(res, 403, { error: '仅本机页面可请求文件定位。' }); return;
        }
        if (action === 'location' && req.method !== 'GET') { status = 405; sendJson(res, 405, { error: 'method not allowed' }); return; }
        const abs = await library.resolve(actionMatch[1]);
        if (!abs) { status = 404; sendJson(res, 404, { error: 'unknown media id' }); return; }
        if (action === 'reveal') await (options.reveal ?? revealFile)(abs);
        sendJson(res, 200, action === 'location' ? { absolutePath: options.proxyToken ? null : abs, reveal: !!options.allowLocalReveal && localRequest(req) } : { ok: true });
        return;
      }
      // Users explicitly submit a problem log from
      // the log panel. Bounded body, JSON shape-checked, written to logsDir.
      if (url.pathname === '/api/logs' && req.method === 'POST') {
        if (!options.logsDir) { status = 404; sendJson(res, 404, { error: 'log upload not enabled' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 10 * 1024 * 1024) { status = 413; sendJson(res, 413, { error: '日志过大' }); req.destroy(); return; }
          chunks.push(chunk as Buffer);
        }
        let doc: { schema?: unknown; sessionId?: unknown };
        try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { status = 400; sendJson(res, 400, { error: '不是有效的 JSON' }); return; }
        if (doc?.schema !== 'voidplayer-web-log' || typeof doc.sessionId !== 'string' || !/^[0-9a-zA-Z-]{1,100}$/.test(doc.sessionId)) {
          status = 400; sendJson(res, 400, { error: '不是有效的日志文档' }); return;
        }
        await fs.mkdir(options.logsDir, { recursive: true });
        const receivedAt = new Date().toISOString();
        const name = `voidplayer-log-${receivedAt.replace(/[:.]/g, '-')}-${requestId}-${doc.sessionId.slice(0, 8)}.json`;
        await fs.writeFile(path.join(options.logsDir, name), JSON.stringify({ ...doc, serverReceipt: { id: requestId, receivedAt, actorId: actor?.id ?? (localRequest(req) ? 'local' : null) } }), { flag: 'wx', mode: 0o600 });
        status = 201; sendJson(res, 201, { ok: true, name });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        status = 405; sendJson(res, 405, { error: 'read only' }); return;
      }
      if (url.pathname === '/api/library') {
        const listing = await library.list(url.searchParams.get('refresh') === '1');
        sendJson(res, 200, listing);
        return;
      }
      const mediaMatch = /^\/api\/media\/([0-9a-f]{24})$/.exec(url.pathname);
      if (mediaMatch) {
        const requestedVersion = url.searchParams.get('v') ?? undefined;
        const metadata = library.metadata(mediaMatch[1]);
        if (requestedVersion && metadata && requestedVersion !== metadata.version) { status = 409; sendJson(res, 409, { error: '媒体内容已改变，请重新载入。' }); return; }
        const abs = await library.resolve(mediaMatch[1], requestedVersion);
        if (!abs) { status = 404; sendJson(res, 404, { error: 'unknown media id' }); return; }
        if (url.searchParams.has('download')) res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
        await serveFile(req, res, abs, undefined, metadata?.version);
        return;
      }
      if (staticDir) {
        const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : ['/admin', '/admin/'].includes(url.pathname) ? '/admin/index.html' : url.pathname);
        const root = await staticRoot;
        const candidate = root ? path.join(root, rel) : '';
        const real = await fs.realpath(candidate).catch(() => null);
        if (root && real && (real === root || real.startsWith(root + path.sep)) && (await fs.stat(real)).isFile()) {
          await serveFile(req, res, real);
          return;
        }
        status = 404; sendJson(res, 404, { error: 'not found' });
        return;
      }
      status = 404; sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      status = 500;
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  if (!options.library) server.on('close', () => { void library.close(); });
  return server;
}
