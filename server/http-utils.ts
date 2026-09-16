import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileVersion } from './library.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.flv': 'video/x-flv', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

// Cross-origin isolation headers enable SharedArrayBuffer for the
// multi-threaded WASM decoder core. Everything we serve is same-origin, so
// require-corp is safe here.
export const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'unsatisfiable';
  let start: number, end: number;
  if (match[1] === '') { // suffix: last N bytes
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return 'unsatisfiable';
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function serveFile(req: IncomingMessage, res: ServerResponse, absPath: string, contentType?: string, expectedVersion?: string) {
  const handle = await fs.open(absPath, 'r').catch(() => null);
  if (!handle) { sendJson(res, 404, { error: 'not found' }); return; }
  try {
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
    if (expectedVersion && fileVersion(stat) !== expectedVersion) { sendJson(res, 409, { error: '媒体内容已改变，请重新载入。' }); return; }
    const size = stat.size;
    const type = contentType ?? MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    const base = { etag: `"${fileVersion(stat)}"`, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      ...base,
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    if (size === 0) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
