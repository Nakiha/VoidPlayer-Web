import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { resolveMediaPath, scanLibrary } from './library.ts';

// Narrow read-only HTTP API for the web player:
//   GET /api/library        -> media list under the whitelisted folders
//   GET|HEAD /api/media/<id> -> file bytes with HTTP Range support
// plus static hosting of the built frontend (dist/) when present.

export interface ServerOptions {
  roots: string[];
  staticDir?: string;
  /** Directory that receives user-submitted logs (POST /api/logs). */
  logsDir?: string;
  onLog?: (entry: Record<string, unknown>) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
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

async function serveFile(req: IncomingMessage, res: ServerResponse, absPath: string, contentType?: string) {
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
  const size = stat.size;
  const type = contentType ?? MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
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
  createReadStream(absPath, { start, end }).pipe(res);
}

export function createMediaServer(options: ServerOptions): Server {
  const roots = options.roots.map(r => path.resolve(r));
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : undefined;
  const logLine = options.onLog ?? (entry => console.log(JSON.stringify(entry)));

  return createServer(async (req, res) => {
    const started = performance.now();
    let status = 200;
    const finish = () => logLine({ t: new Date().toISOString(), method: req.method, url: req.url, status, ms: Math.round(performance.now() - started) });
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // The single write endpoint: users explicitly submit a problem log from
      // the log panel. Bounded body, JSON shape-checked, written to logsDir.
      if (url.pathname === '/api/logs' && req.method === 'POST') {
        if (!options.logsDir) { status = 404; sendJson(res, 404, { error: 'log upload not enabled' }); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 10 * 1024 * 1024) { status = 413; sendJson(res, 413, { error: '日志过大' }); req.destroy(); return; }
          chunks.push(chunk as Buffer);
        }
        let doc: { schema?: unknown; sessionId?: unknown };
        try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { status = 400; sendJson(res, 400, { error: '不是有效的 JSON' }); return; }
        if (doc?.schema !== 'voidplayer-web-log' || typeof doc.sessionId !== 'string' || !/^[0-9a-zA-Z-]{1,100}$/.test(doc.sessionId)) {
          status = 400; sendJson(res, 400, { error: '不是有效的日志文档' }); return;
        }
        await fs.mkdir(options.logsDir, { recursive: true });
        const name = `voidplayer-log-${new Date().toISOString().replace(/[:.]/g, '-')}-${doc.sessionId.slice(0, 8)}.json`;
        await fs.writeFile(path.join(options.logsDir, name), JSON.stringify(doc));
        status = 201; sendJson(res, 201, { ok: true, name });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        status = 405; sendJson(res, 405, { error: 'read only' }); return;
      }
      if (url.pathname === '/api/library') {
        const library = await scanLibrary(roots);
        sendJson(res, 200, { roots: library.roots, truncated: library.truncated, entries: library.entries });
        return;
      }
      const mediaMatch = /^\/api\/media\/([0-9a-f]{24})$/.exec(url.pathname);
      if (mediaMatch) {
        const abs = await resolveMediaPath(roots, mediaMatch[1]);
        if (!abs) { status = 404; sendJson(res, 404, { error: 'unknown media id' }); return; }
        await serveFile(req, res, abs);
        return;
      }
      if (staticDir) {
        const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const candidate = path.join(staticDir, rel);
        const real = await fs.realpath(candidate).catch(() => null);
        if (real && (real === staticDir || real.startsWith(staticDir + path.sep)) && (await fs.stat(real)).isFile()) {
          await serveFile(req, res, real);
          return;
        }
        status = 404; sendJson(res, 404, { error: 'not found' });
        return;
      }
      status = 404; sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      status = 500;
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    } finally {
      finish();
    }
  });
}
