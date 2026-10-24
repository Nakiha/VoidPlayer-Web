import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from '../../routes/context.ts';
import { AdminError, adminErrorBody } from '../../admin-error.ts';
import { adminWriteAllowed, readAdminJson } from '../../admin.ts';
import { sendJson } from '../../http-utils.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import { QUALITY_JOB_LIMITS } from '../../../shared/analysis/quality/jobs.ts';
import { qualityKeys } from './request.ts';

export async function handleQualityJobRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL) {
  const collection = url.pathname === '/api/quality/jobs';
  const item = /^\/api\/quality\/jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(result|cancel))?$/.exec(url.pathname);
  if (!collection && !item) return false;
  try {
    if (!ctx.actor) throw new AdminError(401, 'Select an intranet identity first.', 'identity-required');
    if (req.method !== 'GET' && !adminWriteAllowed(req, 'quality-job'))
      throw new AdminError(403, 'Use the same-origin quality-job action.', 'origin-required');
    const jobs = ctx.library.qualityJobs;
    if (collection && req.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key)))
        throw new AdminError(400, 'Unknown history query.', 'invalid-request');
      sendJson(res, 200, {...jobs.changes(ctx.actor.id, Number(url.searchParams.get('after') ?? 0),
        Number(url.searchParams.get('limit') ?? QUALITY_JOB_LIMITS.pageSize)), resources: jobs.resources(), limits: QUALITY_JOB_LIMITS});return true;
    }
    if (url.search) throw new AdminError(400, 'Unexpected job query.', 'invalid-request');
    if (item && req.method === 'GET' && item[2] !== 'cancel') {
      sendJson(res, 200, item[2] === 'result' ? jobs.result(item[1], ctx.actor.id) : jobs.get(item[1], ctx.actor.id));return true;
    }
    if (req.method !== 'POST' || (item && item[2] !== 'cancel')) throw new AdminError(405, 'Method not allowed.');
    const timer = setTimeout(() => req.destroy(new Error('Quality job body timeout')), 10000);
    try {
      const body = await readAdminJson(req, collection ? QUALITY_JOB_LIMITS.requestBytes : 256);clearTimeout(timer);
      if (collection) {
        const accepted = jobs.submit(body, ctx.actor, ctx.requestId, req.headers['idempotency-key']);
        res.setHeader('location', `/api/quality/jobs/${accepted.job.id}`);
        if (!res.destroyed) sendJson(res, accepted.replayed ? 200 : 202, accepted);
      } else {
        qualityKeys(body, []);
        const job = jobs.cancel(item![1], ctx.actor.id, ctx.requestId);
        if (!res.destroyed) sendJson(res, 200, job);
      }
    } finally { clearTimeout(timer); }
  } catch (error) {
    if (!res.destroyed && !res.headersSent) sendJson(res, error instanceof AdminError ? error.status : error instanceof FramePairError ? 400 : 500,
      error instanceof AdminError || error instanceof FramePairError ? {...adminErrorBody(error), code:error.code}
        : {error:'Quality job operation failed.',code:'quality-service-error'});
  }
  return true;
}
