import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from './http.ts';

export function matchesEtag(header: string | undefined, etag: string) {
  return header?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag) ?? false;
}

/** Private, actor-scoped snapshots; errors and mutations keep their existing no-store policy. */
export function sendSnapshot(req: IncomingMessage, res: ServerResponse, body: unknown, scope = '') {
  const payload = JSON.stringify(body), etag = `"${createHash('sha256').update(scope).update('\0').update(payload).digest('base64url')}"`;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', vary: 'Cookie', etag };
  if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
