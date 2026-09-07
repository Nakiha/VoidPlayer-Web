import { mkdtemp, mkdir, readFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../server/config.ts';
import { MediaLibraryIndex } from '../server/library.ts';
import { AdminController } from '../server/admin.ts';
import { createMediaServer } from '../server/app.ts';

export async function startupFixture(nodeOrigin = false) {
  const root = path.resolve(import.meta.dirname, '..'), temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-flv-startup-'));
  const media = path.join(temporary, 'media'); await mkdir(media); await mkdir(path.join(temporary, 'data'));
  const original = await readFile(path.join(root, 'fixtures/flv/standard-h264.flv'));
  const file = path.join(media, 'startup.flv'), handle = await open(file, 'w');
  try {
    await handle.write(original, 0, original.length, 0); let offset = original.length;
    // Sparse 256 MiB tail: valid audio tags, without allocating the payloads.
    for (let i = 0; i < 32; i++) {
      const header = Buffer.alloc(11), size = 8 * 1024 * 1024; header[0] = 8; header.writeUIntBE(size, 1, 3);
      await handle.write(header, 0, 11, offset); offset += 11 + size;
      const footer = Buffer.alloc(4); footer.writeUInt32BE(size + 11); await handle.write(footer, 0, 4, offset); offset += 4;
    }
    // Incomplete final video tag reproduces interrupted CDN recordings.
    const tail = Buffer.alloc(853); tail[0] = 9; tail.writeUIntBE(5639, 1, 3);
    await handle.write(tail, 0, tail.length, offset);
  } finally { await handle.close(); }
  const config = await loadConfig(['--folder', media], 'production', temporary); config.dataDir = path.join(temporary, 'data');
  const library = new MediaLibraryIndex([media], { watch: false }); await library.refresh();
  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: [media], library, admin, staticDir: path.join(root, 'dist'), onLog() {} });
  const handler = server.listeners('request')[0]; server.removeAllListeners('request');
  let release!: () => void, block = true, delayed = 0, ranges = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let base = '';
  server.on('request', async (req, res) => {
    if (nodeOrigin && req.method === 'POST' && req.url?.includes('/frame-index')) req.headers.origin = base;
    if (/^\/api\/media\/[a-f0-9]{24}(\?|$)/.test(req.url ?? '') && req.headers.range) {
      ranges++; const start = Number(/^bytes=(\d+)/.exec(req.headers.range)?.[1]);
      if (block && start >= 65536) { delayed++; await gate; if (res.destroyed) return; }
    }
    handler(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const entry = library.browse().entries[0];
  return { base, entry, library, media, file, counts: () => ({ delayed, ranges }),
    release() { block = false; release(); },
    async close() { block = false; release(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await admin.close(); await library.close(); await rm(temporary, { recursive: true, force: true }); },
  };
}
