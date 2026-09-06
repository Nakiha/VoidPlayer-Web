import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { LibraryStore, normalizeRoots, mediaId } from './library-store.ts';
import type { MediaRoot, RootRecord, StoredMedia } from './library-store.ts';
export { mediaId } from './library-store.ts';
export type { MediaRoot } from './library-store.ts';
export const MEDIA_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.avi', '.flv'];
export interface LibraryEntry { id: string; name: string; root: string; rootIndex: number; size: number; lastModified: number; rootId?: string; version?: string; state?: string }
export interface Library { roots: string[]; entries: LibraryEntry[]; truncated: boolean }
interface IndexOptions { database?: string; ttlMs?: number; settleMs?: number; ioTimeoutMs?: number; scan?: typeof scanLibrary; now?: () => number }
export interface BrowseQuery { rootId?: string; directory?: string; search?: string; recursive?: boolean; limit?: number; offset?: number }
export function fileVersion(stat: Stats) { return createHash('sha256').update(`${stat.size}:${Math.round(stat.mtimeMs)}:${Math.round(stat.ctimeMs)}:${stat.ino}`).digest('hex').slice(0, 24); }
const parent = (name: string) => path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);

/** Persistent, progressively updated metadata. Range lookups never wait for a scan. */
export class MediaLibraryIndex {
  readonly roots: string[];
  readonly definitions: RootRecord[];
  private store: LibraryStore;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private initialized: boolean;
  private refreshedAt = -Infinity;
  private options: IndexOptions;
  constructor(roots: MediaRoot[], options: IndexOptions = {}) {
    this.options = options;
    this.definitions = normalizeRoots(roots); this.roots = this.definitions.map(r => r.path);
    this.store = new LibraryStore(options.database);
    try { this.store.configure(this.definitions); } catch (error) { this.store.close(); throw error; }
    this.initialized = !!this.store.db.prepare('SELECT 1 FROM roots WHERE active=1 AND scanned_at IS NOT NULL LIMIT 1').get();
    if (this.initialized) this.refreshedAt = this.now();
  }
  get ready() { return this.initialized; }
  private now() { return (this.options.now ?? Date.now)(); }
  start() {
    if (this.timer || this.closed) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.options.ttlMs ?? 30000);
    this.timer.unref();
  }
  status() {
    const job = this.store.db.prepare('SELECT * FROM scan_jobs ORDER BY id DESC LIMIT 1').get() ?? null;
    const roots = this.store.db.prepare('SELECT id,name,state,error,scanned_at AS scannedAt FROM roots WHERE active=1 ORDER BY name,id').all();
    return { ready: this.ready, scanning: !!this.pending, job, roots, errorDetailsTruncated: Number(job?.errors ?? 0) > 1000 };
  }
  errors(limit = 100, offset = 0) { return this.store.db.prepare('SELECT * FROM scan_errors WHERE job_id=(SELECT MAX(id) FROM scan_jobs) ORDER BY root_id,path LIMIT ? OFFSET ?').all(Math.min(200, Math.max(1, limit)), Math.max(0, offset)); }
  private entry(row: StoredMedia): LibraryEntry {
    const root = this.definitions.find(r => r.id === row.root_id)!;
    return { id: row.id, name: row.path, root: root.name, rootIndex: root.index, rootId: root.id, size: row.size, lastModified: row.modified, version: row.version, state: row.state };
  }
  browse(query: BrowseQuery = {}) {
    const limit = Math.min(200, Math.max(1, query.limit ?? 100)), offset = Math.max(0, query.offset ?? 0);
    const directory = query.directory ?? '';
    if (directory.startsWith('/') || directory.split('/').some(p => p === '..') || directory.includes('\\')) throw new Error('无效的媒体目录。');
    if (query.rootId && !this.definitions.some(r => r.id === query.rootId)) throw new Error('未知媒体根目录。');
    const filters = ['r.active=1', "m.state!='missing'"], values: (string | number)[] = [];
    if (query.rootId) { filters.push('m.root_id=?'); values.push(query.rootId); }
    if (!query.recursive) { filters.push('m.parent=?'); values.push(directory); }
    else if (directory) { filters.push("substr(m.path,1,?)=?"); values.push(directory.length + 1, directory + '/'); }
    if (query.search) { filters.push('instr(lower(m.path),lower(?))>0'); values.push(query.search.slice(0, 300)); }
    const where = filters.join(' AND ');
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS total FROM media m JOIN roots r ON r.id=m.root_id WHERE ${where}`).get(...values) as { total: number }).total;
    const rows = this.store.db.prepare(`SELECT m.* FROM media m JOIN roots r ON r.id=m.root_id WHERE ${where} ORDER BY m.path COLLATE NOCASE,m.path,m.root_id LIMIT ? OFFSET ?`).all(...values, limit, offset) as unknown as StoredMedia[];
    // Folders have their own page so a large directory cannot bypass the media limit.
    const folders = query.recursive ? [] : this.store.db.prepare(`SELECT d.root_id AS rootId,d.path,d.name FROM directories d JOIN roots r ON r.id=d.root_id WHERE r.active=1 AND d.path!='' AND d.parent=? ${query.rootId ? 'AND d.root_id=?' : ''} ORDER BY d.name COLLATE NOCASE,d.path,d.root_id LIMIT ? OFFSET ?`).all(directory, ...(query.rootId ? [query.rootId] : []), limit + 1, offset);
    return { entries: rows.map(r => this.entry(r)), directories: folders.slice(0, limit), moreDirectories: folders.length > limit, total, offset, limit, nextOffset: offset + limit < total || folders.length > limit ? offset + limit : null, ...this.status() };
  }
  async list(force = false): Promise<Library> {
    if (force || !this.ready || this.now() - this.refreshedAt >= (this.options.ttlMs ?? 30000)) await this.refresh();
    const rows = this.store.db.prepare("SELECT m.* FROM media m JOIN roots r ON r.id=m.root_id WHERE r.active=1 AND m.state!='missing' ORDER BY m.path COLLATE NOCASE,m.path,m.root_id LIMIT 5001").all() as unknown as StoredMedia[];
    return { roots: this.definitions.map(r => r.name), entries: rows.slice(0, 5000).map(r => this.entry(r)), truncated: rows.length > 5000 };
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('媒体索引已关闭。'));
    if (this.pending) return this.pending;
    const controller = this.abort = new AbortController();
    this.pending = this.scan(controller.signal).finally(() => { this.pending = null; this.abort = null; });
    return this.pending;
  }
  cancel() {
    this.abort?.abort();
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cancel();
  }
  private async io<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException('扫描已取消', 'AbortError');
    let timer: ReturnType<typeof setTimeout>;
    let stop: () => void = () => {};
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        stop = () => reject(new DOMException('扫描已取消', 'AbortError'));
        signal?.addEventListener('abort', stop, { once: true });
        timer = setTimeout(() => reject(Object.assign(new Error('存储读取超时'), { code: 'ETIMEDOUT' })), this.options.ioTimeoutMs ?? 10000);
      })]);
    } finally { clearTimeout(timer!); signal?.removeEventListener('abort', stop); }
  }
  private async scan(signal: AbortSignal) {
    const db = this.store.db;
    const job = Number(db.prepare("INSERT INTO scan_jobs(state,started_at) VALUES('running',?)").run(this.now()).lastInsertRowid);
    let visited = 0, files = 0, errors = 0, needsSettle = false;
    const progress = (root?: string, directory?: string) => db.prepare('UPDATE scan_jobs SET visited=?,files=?,errors=?,current_root=?,current_path=? WHERE id=?').run(visited, files, errors, root ?? null, directory ?? null, job);
    const upsert = db.prepare(`INSERT INTO media(id,root_id,path,parent,size,modified,version,state,generation,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET size=excluded.size,modified=excluded.modified,version=excluded.version,state=excluded.state,generation=excluded.generation,observed_at=CASE WHEN media.version=excluded.version THEN media.observed_at ELSE excluded.observed_at END`);
    const findId = db.prepare('SELECT id FROM media WHERE root_id=? AND path=?');
    const alias = db.prepare('INSERT INTO aliases(id,media_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id');
    const priorVersion = db.prepare('SELECT version,state,observed_at FROM media WHERE root_id=? AND path=?');
    // Keep disk commits bounded, without holding a transaction over network I/O.
    // FULL durability is retained; one commit covers up to 64 media records.
    const writes: (() => void)[] = [];
    const flush = () => {
      if (!writes.length) return;
      db.exec('BEGIN IMMEDIATE');
      try { for (const write of writes) write(); db.exec('COMMIT'); writes.length = 0; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const put = (root: RootRecord, relative: string, size: number, modified: number, version: string, state: string) => {
      const observedAt = this.now();
      writes.push(() => {
        upsert.run(mediaId(root.seed, relative), root.id, relative, parent(relative), size, modified, version, state, job, observedAt);
        const record = findId.get(root.id, relative) as { id: string };
        alias.run(mediaId(root.path, relative), record.id);
      });
      if (writes.length >= 64) flush();
    };
    const errorAt = (root: RootRecord, relative: string, error: unknown) => {
      if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
      const code = String((error as NodeJS.ErrnoException).code ?? 'IO_ERROR'); errors++;
      if (errors <= 1000) db.prepare('INSERT INTO scan_errors(job_id,root_id,path,code,message) VALUES(?,?,?,?,?)').run(job, root.id, relative, code, '无法读取媒体存储');
    };
    try {
      if (this.options.scan) {
        const snapshot = await this.io(this.options.scan(this.roots), signal);
        for (const entry of snapshot.entries) {
          const root = this.definitions[entry.rootIndex];
          const stat = await this.io(fs.stat(path.join(root.path, entry.name)), signal);
          put(root, entry.name, stat.size, Math.round(stat.mtimeMs), fileVersion(stat), 'ready'); files++;
        }
        flush();
        for (const root of this.definitions) db.prepare("UPDATE roots SET state='ready',error=NULL,scanned_at=? WHERE id=?").run(this.now(), root.id);
        db.prepare("UPDATE media SET state='missing' WHERE generation!=?").run(job);
      } else for (const root of this.definitions) {
        if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
        const errorsBefore = errors;
        db.prepare("UPDATE roots SET state='scanning',error=NULL WHERE id=?").run(root.id);
        const stack = ['']; let offline = false;
        let rootReal = '';
        try { rootReal = await this.io(fs.realpath(root.path), signal); }
        catch (error) { errorAt(root, '', error); offline = true; stack.length = 0; }
        while (stack.length) {
          const relative = stack.pop()!;
          progress(root.id, relative);
          let children;
          try {
            // readdir is async: slow/network storage does not occupy the HTTP loop.
            const absolute = await this.io(fs.realpath(path.join(rootReal, relative)), signal);
            if (absolute !== rootReal && !absolute.startsWith(rootReal + path.sep)) throw Object.assign(new Error('目录离开白名单'), { code: 'EPERM' });
            children = await this.io(fs.readdir(absolute, { withFileTypes: true }), signal);
          } catch (error) { errorAt(root, relative, error); if (!relative) offline = true; continue; }
          visited++;
          db.prepare('INSERT INTO directories(root_id,path,parent,name,generation) VALUES(?,?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET generation=excluded.generation').run(root.id, relative, parent(relative), path.posix.basename(relative), job);
          for (const child of children) {
            if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
            if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
            const name = relative ? relative + '/' + child.name : child.name;
            if (child.isDirectory()) { stack.push(name); continue; }
            if (!child.isFile() || !MEDIA_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
            let stat: Stats;
            try { stat = await this.io(fs.lstat(path.join(rootReal, name)), signal); }
            catch (error) { errorAt(root, name, error); continue; }
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const version = fileVersion(stat), settleMs = this.options.settleMs ?? 0;
            const prior = priorVersion.get(root.id, name) as { version: string; state: string; observed_at: number } | undefined;
            const pending = settleMs > 0 && (prior?.version === version ? prior.state === 'pending' && this.now() - prior.observed_at < settleMs : !!prior || this.now() - stat.mtimeMs < settleMs);
            needsSettle ||= pending;
            // Database errors fail the job, rather than being treated as a bad file.
            put(root, name, stat.size, Math.round(stat.mtimeMs), version, pending ? 'pending' : 'ready'); files++;
            if (files % 64 === 0) { progress(root.id, relative); await new Promise<void>(r => setImmediate(r)); }
          }
        }
        flush();
        // Never infer deletion from an incomplete, cancelled or offline scan.
        if (errors === errorsBefore) {
          db.prepare("UPDATE media SET state='missing' WHERE root_id=? AND generation!=?").run(root.id, job);
          db.prepare('DELETE FROM directories WHERE root_id=? AND generation!=?').run(root.id, job);
        }
        db.prepare('UPDATE roots SET state=?,error=?,scanned_at=? WHERE id=?').run(offline ? 'offline' : errors > errorsBefore ? 'partial' : 'ready', errors > errorsBefore ? '部分路径不可读取，查看扫描错误' : null, this.now(), root.id);
      }
      this.initialized = true; this.refreshedAt = this.now(); progress();
      db.prepare("UPDATE scan_jobs SET state=?,finished_at=? WHERE id=?").run(errors ? 'partial' : 'completed', this.now(), job);
      db.prepare('DELETE FROM scan_errors WHERE job_id IN (SELECT id FROM scan_jobs ORDER BY id DESC LIMIT -1 OFFSET 50)').run();
      db.prepare('DELETE FROM scan_jobs WHERE id IN (SELECT id FROM scan_jobs ORDER BY id DESC LIMIT -1 OFFSET 50)').run();
      if (needsSettle && !this.closed) {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => { void this.refresh().catch(() => {}); }, this.options.settleMs ?? 1000); this.settleTimer.unref();
      }
    } catch (error) {
      progress();
      db.prepare('UPDATE scan_jobs SET state=?,finished_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', this.now(), job);
      db.prepare("UPDATE roots SET state=? WHERE active=1 AND state='scanning'").run(signal.aborted ? 'cancelled' : 'error');
      if (!signal.aborted) throw error;
    }
  }
  metadata(id: string) { const row = this.store.find(id); return row ? this.entry(row) : null; }
  async resolve(id: string, version?: string): Promise<string | null> {
    if (!/^[0-9a-f]{24}$/.test(id) || this.closed) return null;
    const entry = this.store.find(id);
    if (!entry || entry.state !== 'ready' || (version && version !== entry.version)) return null;
    const root = this.definitions.find(r => r.id === entry.root_id);
    if (!root) return null;
    try {
      const rootReal = await this.io(fs.realpath(root.path));
      const real = await this.io(fs.realpath(path.join(rootReal, entry.path)));
      if (!real.startsWith(rootReal + path.sep)) return null;
      const stat = await this.io(fs.stat(real));
      if (!stat.isFile() || fileVersion(stat) !== entry.version) return null;
      return real;
    } catch { return null; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.stop();
    await this.pending?.catch(() => {}); this.store.close();
  }
}

/** Compatibility helpers for local callers; HTTP Range must use the shared index. */
export async function scanLibrary(roots: string[]): Promise<Library> {
  const index = new MediaLibraryIndex(roots);
  try { return await index.list(true); } finally { await index.close(); }
}
export async function resolveMediaPath(roots: string[], id: string): Promise<string | null> {
  const index = new MediaLibraryIndex(roots);
  try { await index.list(true); return await index.resolve(id); } finally { await index.close(); }
}
