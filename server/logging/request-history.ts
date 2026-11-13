import { createReadStream, promises as fs } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexDatabase, type IndexDatabase } from '../sqlite.ts';
import type { RequestPage } from '../../shared/service/admin.ts';

type Segment = { name: string; file: string; stat: { size: number; mtimeMs: number } };
/** Disposable disk index: retained JSONL/gzip segments remain the source of truth. */
export class RequestHistory {
  private directory = '';
  private db?: IndexDatabase;
  private segments = new Map<string, { size: number; mtime: number; offset: number }>();
  async sync(files: Segment[]) {
    if (!this.db) {
      this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voidplayer-requests-'));
      this.db = openIndexDatabase(path.join(this.directory, 'requests.sqlite'));
      this.db.exec(`PRAGMA journal_mode=OFF; PRAGMA auto_vacuum=FULL;
        CREATE TABLE requests (segment TEXT NOT NULL, position INTEGER NOT NULL, document TEXT NOT NULL,
          PRIMARY KEY(segment, position)) WITHOUT ROWID;`);
    }
    const db = this.db, present = new Set(files.map(file => file.name));
    for (const name of this.segments.keys()) if (!present.has(name)) {
      db.prepare('DELETE FROM requests WHERE segment = ?').run(name);
      this.segments.delete(name);
    }
    const insert = db.prepare('INSERT OR REPLACE INTO requests VALUES (?, ?, ?)');
    for (const file of files) {
      const previous = this.segments.get(file.name), gzip = file.name.endsWith('.gz');
      if (previous?.size === file.stat.size && previous.mtime === file.stat.mtimeMs) continue;
      const start = !gzip && previous && previous.size <= file.stat.size ? previous.offset : 0;
      db.exec('BEGIN');
      try {
        if (!start) db.prepare('DELETE FROM requests WHERE segment = ?').run(file.name);
        let offset = start, pending = Buffer.alloc(0);
        if (file.stat.size > start) {
          const source = createReadStream(file.file, { start, end: file.stat.size - 1 });
          const input = gzip ? source.pipe(createGunzip()) : source;
          // Forward source errors through the decompressor as well.
          if (gzip) source.on('error', error => input.destroy(error));
          try {
            for await (const chunk of input) {
              pending = Buffer.concat([pending, chunk]);
              let end: number;
              while ((end = pending.indexOf(10)) >= 0) {
                const line = pending.subarray(0, end);
                offset += end + 1; pending = pending.subarray(end + 1);
                if (line.length > 16384) continue;
                let entry;
                try { entry = JSON.parse(line.toString('utf8')); } catch { continue; }
                if (entry?.event !== 'http-request' || typeof entry.requestId !== 'string'
                  || typeof entry.url !== 'string' || entry.method === 'GET' && entry.url.startsWith('/api/admin/')) continue;
                const { t, requestId, clientIp, actorId, method, url, status, completed, ms, query, media, range } = entry;
                insert.run(file.name, offset, JSON.stringify({ t, requestId, clientIp, actorId, method, url, status, completed, ms, query, media, range }));
              }
              // A damaged segment must not accumulate an unbounded partial line.
              if (pending.length > 16384) throw Error('Invalid runtime log record');
            }
          } finally {
            input.destroy(); source.destroy();
            await Promise.allSettled([finished(input), finished(source)]);
          }
        }
        db.exec('COMMIT');
        this.segments.set(file.name, { size: file.stat.size, mtime: file.stat.mtimeMs, offset });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  page(requested: number, pageSize = 40): RequestPage {
    const total = Number(this.db!.prepare('SELECT count(*) AS total FROM requests').get()!.total);
    const pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requested, pages);
    const rows = this.db!.prepare('SELECT document FROM requests ORDER BY segment DESC, position DESC LIMIT ? OFFSET ?')
      .all(pageSize, (page - 1) * pageSize);
    return { recentRequests: rows.map(row => JSON.parse(String(row.document))).reverse(), page, pages, pageSize, total };
  }
  async close() {
    this.db?.close(); this.db = undefined;
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
  }
}
