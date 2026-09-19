import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FLV_INDEX_BYTES } from '../../src/flv-index-cache.ts';
import { AdminError, adminWriteAllowed } from '../admin.ts';
import { readAdminJson } from '../admin.ts';
import { sendJson, serveFile } from '../http-utils.ts';
import { encryptedRequest } from '../tls.ts';
import { allowReveal, localRequest, revealFile } from '../reveal.ts';
import type { RouteContext } from './context.ts';

/** Library, media bytes, frame indexes and user-submitted logs. Returns true when handled. */
export async function handleContentRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { options, library } = ctx;
  if (url.pathname === '/api/library/scan' && req.method === 'GET') {
    sendJson(res, 200, { ...library.status(), errors: library.errors() });
    return true;
  }
  if (url.pathname === '/api/library/scan' && req.method === 'POST') {
    let sameOrigin = false;
    try { const origin = new URL(req.headers.origin ?? ''); sameOrigin = origin.host === req.headers.host && origin.protocol === (encryptedRequest(req) ? 'https:' : 'http:'); } catch {}
    if (!sameOrigin || req.headers['x-voidplayer-action'] !== 'scan') { sendJson(res, 403, { error: '请从播放器或管理页面操作扫描。' }); return true; }
    if (url.searchParams.get('action') === 'cancel') library.cancel();
    else if (!url.searchParams.has('action') || url.searchParams.get('action') === 'refresh') void library.refresh().catch(() => {});
    else { sendJson(res, 400, { error: '未知扫描操作。' }); return true; }
    sendJson(res, 202, library.status());
    return true;
  }
  if (url.pathname === '/api/library/browse' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) { sendJson(res, 400, { error: '无效分页参数。' }); return true; }
    const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) { sendJson(res, 400, { error: '无效版本参数。' }); return true; }
    try { sendJson(res, 200, library.browse({ rootId: url.searchParams.get('root') || undefined, directory: url.searchParams.get('directory') ?? '', search: url.searchParams.get('search') ?? '', recursive: url.searchParams.get('recursive') === '1', limit, offset, revision })); }
    catch (error) { sendJson(res, (error as { code?: string }).code === 'INDEX_CHANGED' ? 409 : 400, { error: (error as Error).message }); }
    return true;
  }
  const indexMatch = /^\/api\/media\/([0-9a-f]{24})\/frame-index$/.exec(url.pathname);
  if (indexMatch) {
    try {
      if (!['GET', 'POST'].includes(req.method ?? '')) throw new AdminError(405, '不支持的帧索引操作。');
      if (req.method === 'POST' && !adminWriteAllowed(req, 'frame-index')) throw new AdminError(403, '请从同源播放器提交帧索引。');
      const version = url.searchParams.get('v'), entry = library.metadata(indexMatch[1]);
      if (!version) throw new AdminError(400, '帧索引需要媒体版本。');
      if (!entry || !await library.resolve(indexMatch[1], version)) throw new AdminError(409, '媒体不可用或已改变。');
      if (req.method === 'GET') { sendJson(res, 200, library.frameIndexes.get(entry.id, version)); return true; }
      const body = await readAdminJson(req, FLV_INDEX_BYTES + 1024) as { index?: unknown; epoch?: unknown } | null;
      if (!body || !await library.resolve(entry.id, version)) throw new AdminError(409, '媒体已改变，未保存旧索引。');
      sendJson(res, 201, library.frameIndexes.put(entry.id, version, entry.size, body.index, body.epoch));
      return true;
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); return true; }
  }
  const actionMatch = /^\/api\/media\/([0-9a-f]{24})\/(location|reveal|metadata)$/.exec(url.pathname);
  if (actionMatch) {
    const action = actionMatch[2];
    if (action === 'metadata') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const entry = library.metadata(actionMatch[1]);
      sendJson(res, entry ? 200 : 404, entry ?? { error: 'unknown media id' });
      return true;
    }
    if (action === 'reveal' && (req.method !== 'POST' || !options.allowLocalReveal || !allowReveal(req))) {
      sendJson(res, 403, { error: '仅本机页面可请求文件定位。' });
      return true;
    }
    if (action === 'location' && req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const abs = await library.resolve(actionMatch[1]);
    if (!abs) { sendJson(res, 404, { error: 'unknown media id' }); return true; }
    if (action === 'reveal') await (options.reveal ?? revealFile)(abs);
    sendJson(res, 200, action === 'location' ? { absolutePath: abs, reveal: !!options.allowLocalReveal && localRequest(req) } : { ok: true });
    return true;
  }
  // Users explicitly submit a problem log from
  // the log panel. Bounded body, JSON shape-checked, written to logsDir.
  // REVIEW-05：与其他写接口一致，要求同源 Origin + x-voidplayer-action，
  // 并经统一 JSON 读取校验 Content-Type，避免 text/plain 简单请求跨站写入。
  if (url.pathname === '/api/logs' && req.method === 'POST') {
    if (!options.logsDir) { sendJson(res, 404, { error: 'log upload not enabled' }); return true; }
    if (!adminWriteAllowed(req, 'log')) { sendJson(res, 403, { error: '请从同源播放器提交日志。' }); return true; }
    let doc: { schema?: unknown; sessionId?: unknown };
    try {
      doc = await readAdminJson(req, 10 * 1024 * 1024) as { schema?: unknown; sessionId?: unknown };
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); return true; }
    if (doc?.schema !== 'voidplayer-web-log' || typeof doc.sessionId !== 'string' || !/^[0-9a-zA-Z-]{1,100}$/.test(doc.sessionId)) {
      sendJson(res, 400, { error: '不是有效的日志文档' });
      return true;
    }
    await fs.mkdir(options.logsDir, { recursive: true });
    const receivedAt = new Date().toISOString();
    const name = `voidplayer-log-${receivedAt.replace(/[:.]/g, '-')}-${ctx.requestId}-${doc.sessionId.slice(0, 8)}.json`;
    await fs.writeFile(path.join(options.logsDir, name), JSON.stringify({ ...doc, serverReceipt: { id: ctx.requestId, receivedAt, actorId: ctx.actor?.id ?? (localRequest(req) ? 'local' : null) } }), { flag: 'wx', mode: 0o600 });
    sendJson(res, 201, { ok: true, name });
    return true;
  }
  if (url.pathname === '/api/library') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const listing = await library.list(url.searchParams.get('refresh') === '1');
    sendJson(res, 200, listing);
    return true;
  }
  const mediaMatch = /^\/api\/media\/([0-9a-f]{24})$/.exec(url.pathname);
  if (mediaMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const requestedVersion = url.searchParams.get('v') ?? undefined;
    const metadata = library.metadata(mediaMatch[1]);
    if (requestedVersion && metadata && requestedVersion !== metadata.version) { sendJson(res, 409, { error: '媒体内容已改变，请重新载入。' }); return true; }
    const abs = await library.resolve(mediaMatch[1], requestedVersion);
    if (!abs) { sendJson(res, 404, { error: 'unknown media id' }); return true; }
    if (url.searchParams.has('download')) res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    await serveFile(req, res, abs, undefined, metadata?.version);
    return true;
  }
  return false;
}
