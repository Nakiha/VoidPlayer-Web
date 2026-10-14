import type { IncomingMessage, ServerResponse } from 'node:http';
import { THUMB_POST_BODY_MAX, THUMB_RECIPE_VERSION, thumbnailImageUrl } from '../../src/thumbnails/contract.ts';
import { AdminError, adminWriteAllowed } from '../admin.ts';
import { adminErrorBody } from '../admin-error.ts';
import { sendJson } from '../http-utils.ts';
import type { RouteContext } from './context.ts';

/** Version-pinned presence, image and upload lifecycle; never starts decoding. */
export async function handleThumbnailRoute(library: RouteContext['library'], req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const thumbMatch = /^\/api\/media\/([0-9a-f]{24})\/(thumbnail|thumbnail-status)$/.exec(url.pathname);
  if (thumbMatch) {
    const thumbId = thumbMatch[1]!, thumbAction = thumbMatch[2]!;
    try {
      const version = url.searchParams.get('v');
      const recipe = url.searchParams.get('recipe') || THUMB_RECIPE_VERSION;
      if (!version) throw new AdminError(400, '缩略图需要媒体版本。');
      if (thumbAction === 'thumbnail-status') {
        // Read-only presence probe: metadata + cache lookup, never decode.
        if (req.method !== 'GET') throw new AdminError(405, '不支持的缩略图操作。');
        const entry = library.metadata(thumbId);
        if (!entry) throw new AdminError(404, 'unknown media id');
        if (entry.version !== version) throw new AdminError(409, '媒体内容已改变，请重新载入。');
        const status = library.thumbnails.status(thumbId, version, recipe);
        res.setHeader('cache-control', 'no-store');
        sendJson(res, 200, status.ready
          ? { state: 'ready', epoch: status.epoch, url: thumbnailImageUrl(thumbId, version, recipe), width: status.width, height: status.height }
          : { state: 'missing', epoch: status.epoch });
        return true;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Same availability boundary as the source bytes: version-pinned and
        // resolvable, otherwise no image.
        const abs = await library.resolve(thumbId, version);
        if (!abs) { res.setHeader('cache-control', 'no-store'); sendJson(res, 404, { error: 'unknown media id' }); return true; }
        const row = library.thumbnails.get(thumbId, version, recipe);
        if (!row) { res.setHeader('cache-control', 'no-store'); sendJson(res, 404, { error: 'thumbnail not found' }); return true; }
        res.setHeader('content-type', 'image/jpeg');
        res.setHeader('content-length', String(row.bytes));
        res.setHeader('etag', `"thumb-${version}-${row.bytes}"`);
        res.setHeader('cache-control', 'private, no-cache');
        if (req.method === 'HEAD') { res.end(); return true; }
        res.end(row.data);
        return true;
      }
      if (req.method === 'POST') {
        if (!adminWriteAllowed(req, 'thumbnail')) throw new AdminError(403, '请从同源播放器提交缩略图。');
        if (!String(req.headers['content-type']).startsWith('image/jpeg')) throw new AdminError(400, '请提交 JPEG 图片。');
        const epoch = Number(url.searchParams.get('epoch'));
        const width = Number(url.searchParams.get('w')), height = Number(url.searchParams.get('h')), sourcePtsUs = Number(url.searchParams.get('pts'));
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > THUMB_POST_BODY_MAX + 1024) throw new AdminError(413, '图片超过单张上限。');
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);
        const result = library.thumbnails.put(thumbId, version, recipe, epoch, body, { width, height, sourcePtsUs });
        sendJson(res, 'deduped' in result && result.deduped ? 200 : 201, result);
        return true;
      }
      throw new AdminError(405, '不支持的缩略图操作。');
    } catch (error) { if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof AdminError ? error.status : 500, adminErrorBody(error)); return true; }
  }
  return false;
}
