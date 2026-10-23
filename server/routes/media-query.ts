import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context.ts';
import { AdminError } from '../admin-error.ts';
import { parseMediaIndexIdentity } from '../../shared/media/indexing/media-index-identity.ts';
import { MEDIA_QUERY_DICTIONARY, MEDIA_QUERY_FIELDS, parseSemanticQuery, QUERY_CONCURRENCY_LIMIT } from '../../shared/media/indexing/semantic-query.ts';

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
  if (!match && url.pathname !== MEDIA_QUERY_DICTIONARY) return false;
  const links = { describedBy: MEDIA_QUERY_DICTIONARY, help: '/agent/library.md', browse: '/api/library/browse?recursive=1' };
  let completeHandling: (() => void) | undefined;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new AdminError(405, 'This endpoint is read-only.', 'method-not-allowed');
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
      body = { ...await library.indexJobs.call('semantic-query', { id, version, identity, query, cursor: url.searchParams.get('cursor') ?? undefined }), links };
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
    completeHandling?.();
  }
  return true;
}
