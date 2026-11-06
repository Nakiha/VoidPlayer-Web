import { REPORT_BODY_BYTES } from '../../shared/service/logging.ts';
import { serverLog } from '../logging/logger.ts';
import { requestAuthority } from '../http.ts';
import { matchesEtag } from '../conditional.ts';
import { containerFromHeader } from '../../shared/media/containers/container-header.ts';
import { fileVersion } from '../library.ts';
import { handleMediaQueryRoutes } from './media-query.ts';
import { handleThumbnailRoute } from './thumbnail.ts';
import { handleFrameIndexRoute } from './frame-index.ts';
import { adminErrorBody } from '../admin-error.ts';
import type { IncomingMessage, ServerResponse } from '../http.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AdminError, adminWriteAllowed } from '../admin.ts';
import { readAdminJson } from '../admin.ts';
import { sendJson, serveFile } from '../http-utils.ts';
import { encryptedRequest } from '../tls.ts';
import { allowReveal, localRequest, revealFile } from '../reveal.ts';
import type { RouteContext } from './context.ts';

/** Library, media bytes, frame indexes and user-submitted logs. Returns true when handled. */
export async function handleContentRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { options, library } = ctx;
  if (await handleMediaQueryRoutes(ctx, req, res, url)) return true;
  if (url.pathname === '/api/library/scan' && req.method === 'GET') {
    sendJson(res, 200, { ...library.status(), errors: library.errors() });
    return true;
  }
  if (url.pathname === '/api/library/scan' && req.method === 'POST') {
    let sameOrigin = false;
    try { const origin = new URL(req.headers.origin ?? ''); sameOrigin = origin.host === requestAuthority(req) && origin.protocol === (encryptedRequest(req) ? 'https:' : 'http:'); } catch {}
    if (!sameOrigin || req.headers['x-voidplayer-action'] !== 'scan') { sendJson(res, 403, { error: '请从播放器或管理页面操作扫描。' }); return true; }
    if (url.searchParams.get('action') === 'cancel') library.cancel();
    else if (!url.searchParams.has('action') || url.searchParams.get('action') === 'refresh') void library.refresh().catch(() => {});
    else { sendJson(res, 400, { error: '未知扫描操作。' }); return true; }
    sendJson(res, 202, library.status());
    return true;
  }
  const rootLocation = /^\/api\/library\/roots\/([^/]+)\/location$/.exec(url.pathname);
  if (rootLocation) {
    if (req.method !== 'GET') {sendJson(res, 405, {error:'method not allowed'}); return true;}
    let id: string;
    try {id = decodeURIComponent(rootLocation[1]);} catch {sendJson(res, 400, {error:'invalid root id'}); return true;}
    const root = library.definitions.find(root => root.id === id);
    sendJson(res, root ? 200 : 404, root ? {absolutePath:root.path} : {error:'unknown library root'});
    return true;
  }
  if (url.pathname === '/api/library/browse' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) { sendJson(res, 400, { error: '无效分页参数。' }); return true; }
    const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) { sendJson(res, 400, { error: '无效版本参数。' }); return true; }
    try {
      const query = { rootId: url.searchParams.get('root') || undefined, directory: url.searchParams.get('directory') ?? '', search: url.searchParams.get('search') ?? '', recursive: url.searchParams.get('recursive') === '1', limit, offset, revision };
      const etag = library.browseEtag(query);
      if (matchesEtag(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { etag, 'cache-control': 'private, no-cache' }); res.end();
      } else {
        const payload = JSON.stringify(library.browse(query));
        res.writeHead(200, { etag, 'cache-control': 'private, no-cache', 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
      }
      library.observeBrowse(query);
    }
    catch (error) { sendJson(res, (error as { code?: string }).code === 'INDEX_CHANGED' ? 409 : 400, adminErrorBody(error)); }
    return true;
  }
  if (await handleFrameIndexRoute(library, req, res, url)) return true;
  if (await handleThumbnailRoute(library, req, res, url)) return true;
  const playbackMatch = /^\/api\/media\/([0-9a-f]{24})\/playback-container$/.exec(url.pathname);
  if (playbackMatch) {
    try {
      if (req.method !== 'GET') throw new AdminError(405, '不支持的媒体播放操作。');
      const id = playbackMatch[1], version = url.searchParams.get('v'), entry = library.metadata(id);
      const absolute = version && entry?.version === version && await library.resolve(id, version);
      if (!absolute || !entry || entry.state !== 'ready') throw new AdminError(409, '媒体不可用或已改变。');
      const handle = await fs.open(absolute, 'r');
      try {
        const bytes = new Uint8Array(Math.min(entry.size, 1024));
        for (let read = 0; read < bytes.length;) {
          const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
          if (!bytesRead) throw new AdminError(409, '媒体在识别期间截断。');
          read += bytesRead;
        }
        if (fileVersion(await handle.stat()) !== version || !await library.resolve(id, version!))
          throw new AdminError(409, '媒体在识别期间改变。');
        sendJson(res, 200, { id, version, size: entry.size, container: containerFromHeader(bytes) });
      } finally { await handle.close(); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, adminErrorBody(error));
    }
    return true;
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
    try {
      const result = await ctx.reports.upload(() => readAdminJson(req, REPORT_BODY_BYTES) as Promise<Record<string, unknown>>,
        { id: ctx.requestId, receivedAt: new Date().toISOString(), actorId: ctx.actor?.id ?? (localRequest(req) ? 'local' : null) });
      sendJson(res, 201, result);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, adminErrorBody(error));
      if (!(error instanceof AdminError)) serverLog.error('report-log-upload-failed', error, { requestId: ctx.requestId });
    }
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
