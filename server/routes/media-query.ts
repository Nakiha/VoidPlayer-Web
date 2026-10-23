import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { RouteContext } from './context.ts';
import { AdminError } from '../admin-error.ts';
import { parseMediaIndexIdentity } from '../../shared/media/indexing/media-index-identity.ts';
import { MEDIA_QUERY_DICTIONARY, MEDIA_QUERY_FIELDS, parseSemanticQuery, QUERY_CONCURRENCY_LIMIT } from '../../shared/media/indexing/semantic-query.ts';
import { parseTechnicalFilter, TECHNICAL_FILTER_PATH } from '../../shared/media/indexing/technical-filter.ts';

// Keep admission until BOTH the handler has settled and the response has
// drained/closed. A disconnected request may still have filesystem work pending.
const activeQueries = new WeakMap<RouteContext['library'], number>();
function admit(library: RouteContext['library'], res: ServerResponse) {
  const active = activeQueries.get(library) ?? 0;
  if (active >= QUERY_CONCURRENCY_LIMIT) throw new AdminError(503, 'Cached media queries are busy; retry later.', 'media-query-busy');
  activeQueries.set(library, active + 1);
  let handled = false, responseDone = res.writableFinished || res.destroyed, released = false;
  const release = () => {
    if (!handled || !responseDone || released) return;
    released = true;
    res.off('finish', completeResponse); res.off('close', completeResponse);
    const remaining = (activeQueries.get(library) ?? 1) - 1;
    if (remaining) activeQueries.set(library, remaining); else activeQueries.delete(library);
  };
  const completeResponse = () => { responseDone = true; release(); };
  res.once('finish', completeResponse); res.once('close', completeResponse);
  return () => { handled = true; release(); };
}

function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) });
  res.end(req.method === 'HEAD' ? undefined : payload);
}
export async function handleMediaQueryRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/api\/media\/([0-9a-f]{24})\/(info|index-query)$/.exec(url.pathname);
  const technical = url.pathname === TECHNICAL_FILTER_PATH;
  if (!match && !technical && url.pathname !== MEDIA_QUERY_DICTIONARY) return false;
  const links = { describedBy: MEDIA_QUERY_DICTIONARY, help: '/agent/library.md', browse: '/api/library/browse?recursive=1' };
  const cancellation = new SharedArrayBuffer(4);
  const cancel = () => Atomics.store(new Int32Array(cancellation), 0, 1);
  res.once('close', cancel);
  let completeHandling: (() => void) | undefined;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new AdminError(405, 'This endpoint is read-only.', 'method-not-allowed');
    if (technical) {
      let query;
      try { query = parseTechnicalFilter(url.searchParams); }
      catch (error) { throw new AdminError(400, (error as Error).message, 'invalid-technical-filter'); }
      const { library } = ctx;
      completeHandling = admit(library, res);
      const availability = async () => {
        const available: boolean[] = [];
        for (const source of query.sources) {
          if (res.destroyed) return null;
          const entry = library.metadata(source.id);
          if (!entry || entry.id !== source.id || entry.version !== source.version) throw new AdminError(409, 'Candidate source changed; browse again.', 'technical-evidence-changed');
          available.push(!!await library.resolve(source.id, source.version));
        }
        return available;
      };
      const before = await availability();
      if (!before || res.destroyed) return true;
      const cached = await library.indexJobs.call('technical-filter', { query, cancellation });
      if (res.destroyed) return true;
      const after = await availability();
      if (!after || res.destroyed) return true;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new AdminError(409, 'Candidate availability changed; restart.', 'technical-evidence-changed');
      // A library revision alone cannot detect cache commits, eviction or clear.
      // Recheck on the same worker with a fresh read snapshot after async stats.
      const verified = await library.indexJobs.call('technical-filter', { query, expectedSnapshot: cached.snapshot, cancellation });
      if (res.destroyed) return true;
      const body = { ...cached, work: { ...cached.work, projectionPasses: 2, candidatesInspected: cached.work.candidatesInspected + verified.work.candidatesInspected,
        identitiesInspected: cached.work.identitiesInspected + verified.work.identitiesInspected, identitiesRead: cached.work.identitiesRead + verified.work.identitiesRead,
        projectionReadBytes: cached.work.projectionReadBytes + verified.work.projectionReadBytes },
        snapshot: createHash('sha256').update(JSON.stringify([cached.snapshot, before])).digest('hex'), candidates: cached.candidates.map((candidate, i) => before[i] ? { ...candidate, availability: 'online' } : {
        ...candidate, availability: 'unavailable', state: 'unknown', reason: 'source-unavailable', evidence: candidate.evidence.map(e => ({ ...e, state: 'unknown', reason: 'source-unavailable', checks: e.checks.map(c => ({ ...c, state: 'unknown' })) })),
      }), links };
      if (Buffer.byteLength(JSON.stringify(body)) > query.byteBudget) throw new AdminError(413, 'Response context exceeds byteBudget.', 'response-budget-too-small');
      json(req, res, 200, body);
      return true;
    }
    if (!match) { json(req, res, 200, MEDIA_QUERY_FIELDS); return true; }
    const allowed = match[2] === 'info' ? ['v', 'offset'] : ['v', 'kind', 'stream', 'schema', 'indexer', 'view', 'axis', 'startTick', 'endTick', 'limit', 'byteBudget', 'cursor'];
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new AdminError(400, 'Unknown or duplicate query parameter.', 'invalid-index-query');
    }
    const version = url.searchParams.get('v');
    if (!version || !/^[0-9a-f]{24}$/.test(version)) throw new AdminError(400, 'Pin the media version from library browse.', 'media-version-required');
    const { library } = ctx, id = match[1], entry = library.metadata(id);
    if (!entry) throw new AdminError(404, 'Media is not in the configured library.', 'media-not-found');
    if (entry.version !== version) throw new AdminError(409, 'Media version changed; browse again.', 'media-version-changed');
    if (res.destroyed) return true;
    completeHandling = admit(library, res);
    // Stat/realpath only; same active-root, symlink and source-version boundary as byte serving.
    if (!await library.resolve(id, version)) throw new AdminError(409, 'Media is offline, changed or outside the configured roots.', 'media-unavailable');
    if (res.destroyed) return true;
    let body: unknown;
    if (match[2] === 'info') {
      const rawOffset = url.searchParams.get('offset') ?? '0';
      if (!/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset)) throw new AdminError(400, 'Invalid inventory offset.', 'invalid-index-query');
      const cached = await library.indexJobs.call('cached-indexes', { id, version, offset: Number(rawOffset) });
      body = { ...cached, source: { id, version }, file: { name: entry.name, size: entry.size, lastModified: entry.lastModified, status: 'known', provenance: 'file-stat' },
        technicalState: cached.indexes.length ? 'cached-streams-only' : Number(rawOffset) ? 'end-of-inventory' : 'not-probed',
        streamInventoryComplete: false, links };
    } else {
      const view = url.searchParams.get('view') ?? 'overview';
      if (view !== 'overview' && view !== 'records') throw new AdminError(400, 'view must be overview or records.', 'invalid-index-query');
      let identity, query;
      try {
        identity = parseMediaIndexIdentity(url.searchParams.get('kind') ?? '', url.searchParams);
        query = view === 'records' ? parseSemanticQuery(url.searchParams) : undefined;
      } catch (error) { throw new AdminError(400, (error as Error).message, 'invalid-index-query'); }
      if (!query && ['axis', 'startTick', 'endTick', 'limit', 'byteBudget', 'cursor'].some(key => url.searchParams.has(key))) throw new AdminError(400, 'Record parameters require view=records.', 'invalid-index-query');
      body = { ...await library.indexJobs.call('semantic-query', { id, version, identity, query, cursor: url.searchParams.get('cursor') ?? undefined, cancellation }), links };
      if (query && Buffer.byteLength(JSON.stringify(body)) > query.byteBudget) throw new AdminError(413, 'Response context exceeds byteBudget.', 'response-budget-too-small');
    }
    if (res.destroyed) return true;
    if (!await library.resolve(id, version)) throw new AdminError(409, 'Media changed while reading the cache.', 'media-unavailable');
    json(req, res, 200, body);
  } catch (error) {
    // Never expose raw filesystem/database errors, root paths or core locations.
    if (res.destroyed) return true;
    const known = error instanceof AdminError;
    if (known && error.status === 503) res.setHeader('retry-after', '1');
    json(req, res, known ? error.status : 500, { error: known && error.status < 500 ? error.message : 'Cached media query failed.',
      code: known ? error.code : 'media-query-failed', requestId: ctx.requestId, links });
  } finally {
    res.off('close', cancel);
    completeHandling?.();
  }
  return true;
}
