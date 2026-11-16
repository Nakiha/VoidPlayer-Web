import {requireMediaVersion} from './media-version.ts';
import type { IncomingMessage, ServerResponse } from '../http.ts';
import { createHash } from 'node:crypto';
import { matchesEtag } from '../conditional.ts';
import { THUMB_RECIPE_VERSION, thumbnailImageUrl } from '../../shared/thumbnails/contract.ts';
import { AdminError } from '../admin.ts';
import { adminErrorBody } from '../admin-error.ts';
import { sendJson } from '../http-utils.ts';
import type { RouteContext } from './context.ts';

/** Presence and HEAD are cheap probes. Only an image GET may start a bounded job. */
export async function handleThumbnailRoute(library: RouteContext['library'], req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const thumbMatch = /^\/api\/media\/([0-9a-f]{24})\/(thumbnail|thumbnail-status)$/.exec(url.pathname);
  if (thumbMatch) {
    const thumbId = thumbMatch[1]!, thumbAction = thumbMatch[2]!;
    try {
      const version = requireMediaVersion(url);
      const recipe = url.searchParams.get('recipe') || THUMB_RECIPE_VERSION;
      if (thumbAction === 'thumbnail-status') {
        // Read-only presence probe: metadata + cache lookup, never decode.
        if (req.method !== 'GET') throw new AdminError(405, '不支持的缩略图操作。');
        const entry = library.metadata(thumbId);
        if (!entry) throw new AdminError(404, 'unknown media id');
        if (entry.version !== version) throw new AdminError(409, '媒体内容已改变，请重新载入。');
        const status = library.thumbnails.status(entry.id, version, recipe);
        res.setHeader('cache-control', 'no-store');
        sendJson(res, 200, status.ready
          ? { state: 'ready', epoch: status.epoch, url: thumbnailImageUrl(thumbId, version, recipe), width: status.width, height: status.height }
          : { state: 'missing', epoch: status.epoch });
        return true;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Same availability boundary as the source bytes: version-pinned and
        // resolvable, otherwise no image.
        const epoch = library.thumbnails.epoch;
        const abs = await library.resolve(thumbId, version);
        if (!abs) { res.setHeader('cache-control', 'no-store'); sendJson(res, 404, { error: 'unknown media id' }); return true; }
        const entry = library.describe(thumbId);
        if (!entry || entry.version!==version) throw new AdminError(404,'unknown media id');
        const cached = library.thumbnails.get(entry.id,version,recipe);
        let bytes:Uint8Array;
        if (cached) bytes=cached.data;
        else {
          if (req.method==='HEAD' || recipe!==THUMB_RECIPE_VERSION) throw new AdminError(404,'thumbnail not found');
          const fingerprint=library.fingerprint(entry.id,version);
          if (!fingerprint) throw new AdminError(404,'media not found');
          const controller=new AbortController(), cancel=()=>controller.abort();
          if (res.destroyed) return true;
          res.once('close',cancel);
          try {
            const image=await library.thumbnailJobs.generate(entry.id,version,epoch,{filePath:abs,fingerprint},controller.signal);
            bytes=image.bytes;
          } finally {res.off('close',cancel);}
          if (res.destroyed) return true;
        }
        res.setHeader('content-type', 'image/jpeg');
        const etag = `"thumb-${createHash('sha256').update(bytes).digest('base64url')}"`;
        res.setHeader('etag', etag);
        res.setHeader('cache-control', 'private, no-cache');
        if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304); res.end(); return true; }
        res.setHeader('content-length', String(bytes.byteLength));
        if (req.method === 'HEAD') { res.end(); return true; }
        res.end(bytes);
        return true;
      }
      throw new AdminError(405, '不支持的缩略图操作。');
    } catch (error) { if (!res.headersSent && !res.destroyed) { res.setHeader('cache-control','no-store'); sendJson(res, error instanceof AdminError ? error.status : 500, adminErrorBody(error)); } return true; }
  }
  return false;
}
