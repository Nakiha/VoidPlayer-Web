import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdminError, adminWriteAllowed, readAdminJson } from '../admin.ts';
import type { AdminController } from '../admin.ts';
import { ANNOTATION_BYTES } from '../annotations.ts';
import { WORKSPACE_BYTES } from '../workspaces.ts';
import { sendJson } from '../http-utils.ts';
import { browserUserId, guestActor, identityCookie } from '../identity.ts';
import { encryptedRequest } from '../tls.ts';
import { localRequest } from '../reveal.ts';
import type { RouteContext } from './context.ts';

/** Identity, annotations, shares, workspaces and admin endpoints. Returns true when handled. */
export async function handleStateRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { options, library } = ctx;
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (!options.admin) { sendJson(res, 503, { error: '当前服务未提供用户存储。' }); return true; }
    sendJson(res, 200, { users: options.admin.workspaces.users() });
    return true;
  }
  if (url.pathname === '/api/identity' && req.method === 'POST') {
    if (!options.admin) { sendJson(res, 503, { error: '当前服务未提供用户存储。' }); return true; }
    if (!adminWriteAllowed(req, 'identity')) { sendJson(res, 403, { error: '请从同源页面设置用户名。' }); return true; }
    try {
      const body = await readAdminJson(req, 2048) as { name?: unknown; id?: unknown; guest?: unknown; mode?: unknown } | null;
      if (body?.mode !== undefined && ((body.mode !== 'rename' && body.mode !== 'create') || typeof body.name !== 'string' || body.id !== undefined || body.guest !== undefined)) throw new AdminError(400, '无效的用户操作。');
      if (body?.guest === true && body.id === undefined && body.name === undefined) {
        if (ctx.actor && ctx.actor.kind !== 'guest') throw new AdminError(409, '已命名用户不能切换为匿名身份。');
        ctx.actor = ctx.actor?.kind === 'guest' ? ctx.actor : guestActor(`guest-${randomUUID()}`)!;
      } else if (body && typeof body.id === 'string' && body.name === undefined) {
        const selected = options.admin.workspaces.user(body.id);
        if (!selected) throw new AdminError(404, '该用户已不存在，请刷新用户列表。');
        if (ctx.actor && ctx.actor.kind !== 'guest' && selected.kind === 'guest') throw new AdminError(409, '已命名用户不能切换为匿名身份。');
        ctx.actor = selected;
      } else {
        if (!body || typeof body.name !== 'string' || body.id !== undefined) throw new AdminError(400, '请填写用户名。');
        ctx.actor = options.admin.workspaces.identify(ctx.actor?.id, body.name, body.mode as 'rename' | 'create' | undefined);
      }
      res.setHeader('set-cookie', identityCookie(ctx.actor, encryptedRequest(req))); sendJson(res, 200, { actor: ctx.actor });
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); }
    return true;
  }
  if (url.pathname === '/api/annotations/spaces' || url.pathname.startsWith('/api/annotations/spaces/')) {
    if (!options.admin) { sendJson(res, 503, { error: '当前服务未提供标注存储。' }); return true; }
    if (req.method !== 'GET' && !adminWriteAllowed(req, 'annotation')) { sendJson(res, 403, { error: '请从同源页面保存标注。' }); return true; }
    if (!ctx.actor && req.method !== 'GET') { sendJson(res, 409, { error: '请先选择用户或以访客继续。' }); return true; }
    if (req.headers['x-voidplayer-actor'] && req.headers['x-voidplayer-actor'] !== ctx.actor?.id) { sendJson(res, 409, { error: '用户已切换，草稿未提交。' }); return true; }
    const store = options.admin.annotations;
    try {
      if (url.pathname === '/api/annotations/spaces') {
        if (req.method === 'GET') { sendJson(res, 200, store.spaces()); return true; }
        if (req.method === 'POST') { sendJson(res, 201, store.createSpace((await readAdminJson(req) as { name: unknown }).name)); return true; }
      }
      const match = /^\/api\/annotations\/spaces\/([a-zA-Z0-9_-]{1,200})(?:\/([a-zA-Z0-9_-]{1,200}))?(?:\/(preview))?$/.exec(url.pathname);
      if (match) {
        const [, space, id, preview] = match;
        if (!id && req.method === 'GET') { sendJson(res, 200, url.searchParams.has('list') ? store.list(space, url.searchParams.get('search') ?? '', url.searchParams.get('deleted') === '1', Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)) : { ...store.changes(space, Number(url.searchParams.get('after') ?? 0)), previewEpoch: store.previewEpoch }); return true; }
        if (!id && req.method === 'POST') { sendJson(res, 200, store.mutate(space, await readAdminJson(req, ANNOTATION_BYTES), ctx.actor!)); return true; }
        if (id === 'previews' && req.method === 'DELETE') { sendJson(res, 200, store.clearPreviews(space)); return true; }
        if (id && preview) {
          const revision = Number(url.searchParams.get('revision'));
          if (req.method === 'GET') {
            const data = store.preview(space, id, revision);
            if (!data) throw new AdminError(404, '预览尚未生成。');
            res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': data.byteLength, 'cache-control': 'private, max-age=60' }); res.end(data); return true;
          }
          if (req.method === 'PUT') {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw new AdminError(413, '预览过大。'); chunks.push(chunk); }
            sendJson(res, 200, store.putPreview(space, id, revision, Buffer.concat(chunks), Number(url.searchParams.get('epoch') ?? -1))); return true;
          }
        }
        if (id && req.method === 'GET') { const record = store.read(space, id); if (!record) throw new AdminError(404, '标注不存在。'); sendJson(res, 200, record); return true; }
      }
      sendJson(res, 405, { error: '不支持的标注操作。' }); return true;
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); return true; }
  }
  if (url.pathname === '/api/shares' || url.pathname.startsWith('/api/shares/')) {
    if (!options.admin) { sendJson(res, 503, { error: '当前服务不支持分享。' }); return true; }
    try {
      if (url.pathname === '/api/shares' && req.method === 'POST') {
        if (!adminWriteAllowed(req, 'workspace')) { sendJson(res, 403, { error: '请从同源页面分享工作区。' }); return true; }
        if (req.headers['x-voidplayer-actor'] && req.headers['x-voidplayer-actor'] !== ctx.actor?.id) { sendJson(res, 409, { error: '用户已切换，请重新分享。' }); return true; }
        const result = options.admin.workspaces.share(await readAdminJson(req, WORKSPACE_BYTES + 2048), ctx.actor);
        sendJson(res, 201, { ...result, path: `/?share=${result.id}` }); return true;
      }
      const id = /^\/api\/shares\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
      if (id && req.method === 'GET') { sendJson(res, 200, options.admin.workspaces.shared(id)); return true; }
      sendJson(res, 405, { error: '分享快照不可修改。' });
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); }
    return true;
  }
  if (url.pathname === '/api/workspaces' || url.pathname.startsWith('/api/workspaces/')) {
    if (!options.admin) { sendJson(res, 503, { error: '当前服务未提供工作区存储。' }); return true; }
    if (req.method !== 'GET' && !adminWriteAllowed(req, 'workspace')) { sendJson(res, 403, { error: '请从同源页面保存工作区。' }); return true; }
    if (!ctx.actor && req.method !== 'GET') { sendJson(res, 409, { error: '请先选择用户或以访客继续。' }); return true; }
    const workspaceActor = ctx.actor ?? { id: 'unselected', name: '访客' };
    if (req.headers['x-voidplayer-actor'] && req.headers['x-voidplayer-actor'] !== workspaceActor.id) { sendJson(res, 409, { error: '用户已切换，请刷新工作区列表后重试。' }); return true; }
    const store = options.admin.workspaces;
    const id = /^\/api\/workspaces\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    try {
      if (url.pathname === '/api/workspaces') {
        if (req.method === 'GET') {
          sendJson(res, 200, store.list(workspaceActor, url.searchParams.get('all') === '1', url.searchParams.get('before') ?? '', url.searchParams.get('search') ?? '')); return true;
        }
        if (req.method === 'POST') { sendJson(res, 201, store.create(await readAdminJson(req, WORKSPACE_BYTES + 2048), workspaceActor)); return true; }
      }
      if (id) {
        if (req.method === 'GET') { const value = store.read(id, workspaceActor); res.setHeader('etag', `"${value.revision}"`); sendJson(res, 200, value); return true; }
        const revision = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : undefined;
        if (req.method === 'PUT') { sendJson(res, 200, store.update(id, revision, await readAdminJson(req, WORKSPACE_BYTES + 2048), workspaceActor)); return true; }
        if (req.method === 'DELETE') { sendJson(res, 200, store.remove(id, revision, workspaceActor)); return true; }
      }
      sendJson(res, 405, { error: '不支持的工作区操作。' }); return true;
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); return true; }
  }
  if (url.pathname.startsWith('/api/admin/')) {
    const admin: AdminController | undefined = options.admin;
    if (!admin) { sendJson(res, 404, { error: '此服务尚未提供管理后台。' }); return true; }
    if (req.method !== 'GET' && !adminWriteAllowed(req)) { sendJson(res, 403, { error: '管理操作必须由同源页面发起。' }); return true; }
    const { sockets, recentRequests, traffic } = ctx.adminExtra;
    // Users are trusted; identity records attribution, never access rights.
    const identity = ctx.actor ?? { id: localRequest(req) ? 'local' : 'guest', name: '访客' };
    try {
      if (url.pathname === '/api/admin/caches' && req.method === 'GET') { sendJson(res, 200, await admin.caches.overview()); return true; }
      const cacheType = /^\/api\/admin\/caches\/([a-z-]+)$/.exec(url.pathname);
      if (cacheType && req.method === 'GET') { sendJson(res, 200, admin.caches.list(cacheType[1]!, Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('search') ?? '')); return true; }
      if (cacheType && req.method === 'DELETE') { sendJson(res, 200, admin.caches.remove(cacheType[1]!, await readAdminJson(req))); return true; }
      if (url.pathname === '/api/admin/frame-indexes') {
        if (req.method === 'GET') { sendJson(res, 200, library.frameIndexes.list(Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('search') ?? '')); return true; }
        if (req.method === 'DELETE') { sendJson(res, 200, library.frameIndexes.remove()); return true; }
      }
      const frameIndex = /^\/api\/admin\/frame-indexes\/([0-9a-f]{24})$/.exec(url.pathname);
      if (frameIndex && req.method === 'DELETE') { sendJson(res, 200, library.frameIndexes.remove(frameIndex[1], url.searchParams.get('v') ?? undefined)); return true; }
      if (url.pathname === '/api/admin/measurements') {
        if (req.method === 'GET') { sendJson(res, 200, admin.measurements.status()); return true; }
        if (req.method === 'POST') { sendJson(res, 202, admin.measurements.start(await readAdminJson(req), identity.id)); return true; }
      }
      const measurement = /^\/api\/admin\/measurements\/([a-f0-9-]{36})(?:\/(transfer|finish))?$/.exec(url.pathname);
      if (measurement) {
        if (req.method === 'POST' && measurement[2] === 'transfer') { await admin.measurements.transfer(req, res, measurement[1], identity.id); return true; }
        if (req.method === 'POST' && measurement[2] === 'finish') { sendJson(res, 200, admin.measurements.finish(measurement[1], identity.id, await readAdminJson(req))); return true; }
        if (req.method === 'DELETE' && !measurement[2]) { sendJson(res, 200, admin.measurements.cancel(measurement[1], identity.id)); return true; }
      }
      if (url.pathname === '/api/admin/status' && req.method === 'GET') {
        sendJson(res, 200, { ...admin.status(), identity, http: { activeRequests: traffic.activeRequests, connections: sockets.size, completedRequests: traffic.completedRequests, abortedRequests: traffic.abortedRequests }, recentRequests }); return true;
      }
      if (url.pathname === '/api/admin/roots') {
        if (req.method === 'GET') { sendJson(res, 200, await admin.roots()); return true; }
        if (req.method === 'PUT') { sendJson(res, 200, await admin.saveRoots(await readAdminJson(req))); return true; }
      }
      if (url.pathname === '/api/admin/scan') {
        if (req.method === 'GET') {
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new AdminError(400, '错误分页位置无效。');
          sendJson(res, 200, { ...library.status(), errors: library.errors(100, offset), offset }); return true;
        }
        if (req.method === 'POST') {
          const body = await readAdminJson(req) as { action?: unknown } | null;
          if (body?.action === 'refresh') void library.refresh().catch(() => {});
          else if (body?.action === 'cancel') library.cancel();
          else throw new AdminError(400, '未知扫描操作。');
          sendJson(res, 202, library.status()); return true;
        }
      }
      if (url.pathname === '/api/admin/logs' && req.method === 'GET') { sendJson(res, 200, await admin.logs(url.searchParams.get('before') ?? '')); return true; }
      const log = /^\/api\/admin\/logs\/([^/]+)$/.exec(url.pathname);
      if (log) {
        const name = decodeURIComponent(log[1]);
        if (req.method === 'GET') { sendJson(res, 200, await admin.readLog(name, url.searchParams.get('v'))); return true; }
        if (req.method === 'DELETE') { sendJson(res, 200, await admin.deleteLog(name, typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].replace(/^"|"$/g, '') : null)); return true; }
      }
      sendJson(res, 405, { error: '不支持的管理操作。' }); return true;
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, { error: (error as Error).message }); else if (!res.destroyed) res.destroy(); return true; }
  }
  return false;
}
