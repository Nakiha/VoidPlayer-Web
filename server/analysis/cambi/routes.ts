import { agentRecoveryFields } from '../../agent-errors.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from '../../routes/context.ts';
import { requireCapturedActor } from '../../identity.ts';
import { AdminError, adminErrorBody } from '../../admin-error.ts';
import { adminWriteAllowed, readAdminJson } from '../../admin.ts';
import { sendJson } from '../../http-utils.ts';
export async function handleCambiRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!url.pathname.startsWith('/api/quality/cambi')) return false;
  try {
    const service = ctx.quality.qualityCambi;
    if (url.pathname === '/api/quality/cambi/capability' && req.method === 'GET') {
      sendJson(res, 200, await service.capability());
      return true;
    }
    requireCapturedActor(req, ctx.actor);
    if (!ctx.actor) throw new AdminError(401, 'Choose an identity', 'identity-required');
    const actor = ctx.actor;
    const shared =
      /^\/api\/quality\/cambi\/shared\/([A-Za-z0-9_-]{1,200})\/([A-Za-z0-9_-]{1,200})\/([A-Za-z0-9_-]{1,200})(?:\/(picture))?$/.exec(
        url.pathname,
      );
    if (shared && req.method === 'GET') {
      if ([...url.searchParams.keys()].some((k) => k !== 'scale' || shared[4] || url.searchParams.getAll(k).length !== 1))
        throw new AdminError(400, 'Unexpected query', 'invalid-request');
      const record = ctx.options.admin?.annotations.read(shared[1], shared[2]);
      const e = record?.document.mark.cambiEvidence?.find((e) => e.id === shared[3]);
      if (!e || record?.deleted) throw new AdminError(404, 'Shared CAMBI attachment missing', 'cambi-not-found');
      if (shared[4]) {
        const controller = new AbortController(),
          abort = () => controller.abort(new Error('Picture observer disconnected'));
        res.once('close', abort);
        try {
          const value = await service.sharedPicture(e, controller.signal);
          const current = ctx.options.admin?.annotations.read(shared[1], shared[2]);
          if (current?.deleted || !current?.document.mark.cambiEvidence?.some((item) => JSON.stringify(item) === JSON.stringify(e)))
            throw new AdminError(409, 'Shared CAMBI evidence changed', 'evidence-changed');
          sendJson(res, 200, value);
        } finally {
          res.off('close', abort);
        }
        return true;
      }
      const data = service.sharedHeatmap(e, url.searchParams.has('scale') ? Number(url.searchParams.get('scale')) : e.ref.scale);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
        'cache-control': 'no-store',
        'x-content-sha256':
          e.value.frame.heatmaps[url.searchParams.has('scale') ? Number(url.searchParams.get('scale')) : e.ref.scale].sha256,
      });
      res.end(data);
      return true;
    }
    const collection = url.pathname === '/api/quality/cambi/jobs',
      item =
        /^\/api\/quality\/cambi\/jobs\/(cambi-[a-f0-9-]{36})(?:\/(result|frames|heatmap|picture|cancel|stop-and-keep|candidates))?$/.exec(
          url.pathname,
        );
    const allowed =
      req.method === 'GET' && (collection || item?.[2] === 'frames')
        ? ['after', 'limit']
        : item?.[2] === 'heatmap'
          ? ['index', 'scale']
          : item?.[2] === 'picture'
            ? ['index']
            : [];
    if ([...url.searchParams.keys()].some((k) => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1))
      throw new AdminError(400, 'Invalid CAMBI query', 'invalid-request');
    if (req.method === 'GET') {
      if (collection)
        sendJson(
          res,
          200,
          service.history(actor.id, Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 8)),
        );
      else if (item?.[2] === 'result') sendJson(res, 200, service.summary(item[1], actor.id));
      else if (item?.[2] === 'frames')
        sendJson(
          res,
          200,
          service.frames(item[1], actor.id, Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 4)),
        );
      else if (item?.[2] === 'picture') {
        const index = Number(url.searchParams.get('index'));
        if (!url.searchParams.has('index') || !Number.isInteger(index))
          throw new AdminError(400, 'Declare picture index', 'invalid-request');
        const c = new AbortController(),
          abort = () => c.abort(new Error('Picture observer disconnected'));
        res.once('close', abort);
        try {
          sendJson(res, 200, await service.picture(item[1], actor.id, index, c.signal));
        } finally {
          res.off('close', abort);
        }
      } else if (item?.[2] === 'heatmap') {
        const index = Number(url.searchParams.get('index')),
          scale = Number(url.searchParams.get('scale'));
        if (!['index', 'scale'].every((k) => url.searchParams.has(k)) || !Number.isInteger(index) || !Number.isInteger(scale))
          throw new AdminError(400, 'Declare heatmap frame and scale', 'invalid-request');
        const m = service.heatmap(item[1], actor.id, index, scale);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(m.data.length),
          'cache-control': 'no-store',
          'x-content-sha256': m.sha256,
          'x-voidplayer-evidence-state': m.validation,
        });
        res.end(m.data);
      } else if (item?.[2] === 'candidates') sendJson(res, 200, service.publication(item[1], actor.id));
      else if (item && !item[2]) sendJson(res, 200, service.get(item[1], actor.id));
      else throw new AdminError(404, 'CAMBI route missing', 'cambi-not-found');
      return true;
    }
    if (req.method !== 'POST' || (!collection && !['cancel', 'stop-and-keep', 'candidates'].includes(item?.[2] ?? '')))
      throw new AdminError(405, 'Method not allowed', 'method-not-allowed');
    if (!adminWriteAllowed(req, 'quality-job')) throw new AdminError(403, 'Same origin quality-job action required', 'origin-required');
    const timer = setTimeout(() => req.destroy(Error('CAMBI body deadline')), 10000);
    try {
      const body = await readAdminJson(req, 16384);
      if (collection) {
        const value = service.submit(body, actor, ctx.requestId, req.headers['idempotency-key']);
        res.setHeader('location', `/api/quality/cambi/jobs/${value.job.id}`);
        sendJson(res, value.replayed ? 200 : 202, value);
      } else if (item![2] === 'cancel' || item![2] === 'stop-and-keep') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
          throw new AdminError(400, 'Empty cancel body required', 'invalid-request');
        sendJson(res, 200, item![2] === 'cancel' ? service.cancel(item![1], actor.id) : service.stopAndKeep(item![1], actor.id));
      } else {
        if (!ctx.options.admin) throw new AdminError(503, 'Annotations unavailable', 'storage-unavailable');
        sendJson(
          res,
          200,
          service.publish(item![1], actor, body, new URL(req.headers.origin!).origin, ctx.options.admin.annotations, ctx.requestId),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (!res.headersSent && !res.destroyed)
      sendJson(res, error instanceof AdminError ? error.status : 400, {
        ...adminErrorBody(error),
        code: (error as { code?: string }).code ?? 'cambi-operation-failed',
        ...agentRecoveryFields((error as { code?: string }).code ?? 'cambi-operation-failed', 'cambi.submit'),
      });
  }
  return true;
}
