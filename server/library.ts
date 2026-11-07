import { VIDEO_EXTENSIONS as MEDIA_EXTENSIONS } from '../shared/media/containers/video-files.ts';
import {closeResources} from './shutdown.ts';
import {mutateLibraryFiles,parseLibraryFileCommand} from './library-files.ts';
import {LibraryRelocations} from './library-relocations.ts';
import type {LibraryFileResult} from '../shared/service/library-files.ts';
import {FrameIndexJobs} from './frame-index-jobs.ts';
import type {LibraryScanStatus} from '../shared/service/admin.ts';
import { AdminError } from './admin-error.ts';
import { FrameIndexStore } from './frame-index-store.ts';
import { MediaThumbnailStore } from './media-thumbnail-store.ts';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { LibraryStore, normalizeRoots, mediaId } from './library-store.ts';
import { THUMB_RECIPE_VERSION } from '../shared/thumbnails/contract.ts';
import type { MediaRoot, RootRecord, StoredMedia } from './library-store.ts';
import { DirectoryChanges, DirectoryWatchHints } from './library-watch.ts';
import type { DirectoryScope } from './library-watch.ts';
import { LIBRARY_RECHECK_MS, LibraryScanScheduler } from './library-scheduler.ts';
export { mediaId } from './library-store.ts';
export type { MediaRoot } from './library-store.ts';
export { MEDIA_EXTENSIONS };
export interface LibraryEntry { id: string; name: string; root: string; rootIndex: number; size: number; lastModified: number; rootId?: string; version?: string; state?: string }
export interface Library { roots: string[]; entries: LibraryEntry[]; truncated: boolean }
interface IndexOptions { analysisCoreDir?:string; database?: string; coreDir?: string; ttlMs?: number; settleMs?: number; ioTimeoutMs?: number; watch?: boolean; debounceMs?: number; scanDelayMs?: number; scanBatchDelayMs?: number; scan?: typeof scanLibrary; now?: () => number }
export interface BrowseQuery { rootId?: string; directory?: string; search?: string; recursive?: boolean; limit?: number; offset?: number; revision?: number }
export function fileVersion(stat: Stats) { return createHash('sha256').update(`${stat.size}:${Math.round(stat.mtimeMs)}:${Math.round(stat.ctimeMs)}:${stat.ino}`).digest('hex').slice(0, 24); }
const parent = (name: string) => path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);

/** Persistent, progressively updated metadata. Range lookups never wait for a scan. */
export class MediaLibraryIndex {
  private readonly browseEpoch = randomUUID();
  readonly roots: string[];
  readonly definitions: RootRecord[];
  private store: LibraryStore;
  readonly indexJobs: FrameIndexJobs;
  private closing?:Promise<void>;
  private stopping?:Promise<void>;
  private coreDirectory:string;
  readonly frameIndexes: FrameIndexStore;
  readonly thumbnails: MediaThumbnailStore;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private resumeAt = 0;
  private scheduler: LibraryScanScheduler;
  private storageReads = new Set<Promise<unknown>>();
  // Updated by existing storage checks; browse/status never touch the filesystem.
  private storageSpace = new Map<string, { path: string; availableBytes: number; totalBytes: number }>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private changes = new DirectoryChanges();
  private automaticChanges = new DirectoryChanges(false);
  private settling = new DirectoryChanges(false);
  private watchers: DirectoryWatchHints | null = null;
  private fullScan = false;
  private cancelGeneration = 0;
  private stopped = false;
  private closed = false;
  private configuring = false;
  private fileMutation?:Promise<LibraryFileResult>;
  private relocations?:LibraryRelocations;
  private inventoryCache?:{revision:number;media:number;pending:number};
  private rootScans = new Map<string, Promise<void>>();
  private initialized: boolean;
  private options: IndexOptions;
  constructor(roots: MediaRoot[], options: IndexOptions = {}) {
    this.options = options;
    this.definitions = normalizeRoots(roots); this.roots = this.definitions.map(r => r.path);
    this.store = new LibraryStore(options.database);
    this.coreDirectory=path.resolve(options.coreDir ?? process.env.VOIDPLAYER_WASM_CORE_DIR ?? path.resolve(process.cwd(),'public/vendor/voidplayer-core'));
    this.indexJobs = new FrameIndexJobs(this.store.file, this.coreDirectory);
    this.frameIndexes = new FrameIndexStore(this.store.db);
    this.thumbnails = new MediaThumbnailStore(this.store.db);
    try { this.store.configure(this.definitions); } catch (error) { this.store.close(); throw error; }
    this.scheduler = new LibraryScanScheduler(this.store.db, () => this.now(), options.ttlMs ?? LIBRARY_RECHECK_MS, options.settleMs ?? 0);
    this.initialized = !!this.store.db.prepare('SELECT 1 FROM roots WHERE active=1 AND scanned_at IS NOT NULL LIMIT 1').get();
    this.initialized ||= !!this.store.db.prepare('SELECT 1 FROM library_directory_checks WHERE checked_at IS NOT NULL LIMIT 1').get();
  }
  get corePaths(){return {decoding:this.coreDirectory,analysis:this.options.analysisCoreDir??path.join(path.dirname(this.coreDirectory),'voidplayer-analysis')};}
  get analysisDirectory() { return path.join(path.dirname(this.store.file), 'bitstream-analysis'); }
  get indexDatabase() { return this.store.file; }
  get ready() { return this.initialized; }
  private now() { return (this.options.now ?? Date.now)(); }
  start() {
    if (this.started || this.closed) return;
    this.started = true; this.stopped = false; this.resumeAt = 0;
    if (this.options.watch !== false && !this.options.scan) this.watchers = new DirectoryWatchHints(scope => {
      this.automaticChanges.add(scope); this.scheduleChanges();
    });
    this.scheduleAutomatic(0);
  }
  private scheduleAutomatic(delay = this.options.scanDelayMs ?? 250) {
    if (!this.started || this.timer || this.closed || this.configuring || this.pending || this.storageReads.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending || this.storageReads.size || !this.started || this.closed) return;
      if (this.now() < this.resumeAt) { this.scheduleAutomatic(Math.min(1000, this.resumeAt - this.now())); return; }
      const scope = this.scheduler.next();
      if (!scope) { this.scheduleAutomatic(Math.min(this.options.ttlMs ?? LIBRARY_RECHECK_MS, 1000)); return; }
      void this.runScan([scope], true).catch(() => {}).finally(() => this.scheduleAutomatic());
    }, delay);
    this.timer.unref();
  }
  /** HTTP observations only change scheduling priority; cached replies never wait
   * for storage, and global searches do not enqueue full scans. */
  observeBrowse(query: BrowseQuery = {}) {
    if (!this.started || this.closed || this.configuring || query.recursive && !query.rootId && !query.directory) return;
    const directory = query.directory ?? '';
    if (directory && directory.split('/').some(p => !p || p.startsWith('.')) || directory.includes('\\')) return;
    for (const root of this.definitions) if (!query.rootId || root.id === query.rootId)
      this.scheduler.observe({ rootId: root.id, directory }, !!query.recursive);
    this.scheduleAutomatic();
  }
  status(): LibraryScanStatus {
    const revision=Number(this.store.db.prepare('SELECT revision FROM library_revision WHERE id=1').get()!.revision);
    if (this.inventoryCache?.revision!==revision) {
      const counts=this.store.db.prepare(`SELECT count(*) AS media,coalesce(sum(m.state='pending'),0) AS pending
        FROM media m JOIN roots r ON r.id=m.root_id WHERE r.active=1 AND m.state!='missing'`).get()!;
      this.inventoryCache={revision,media:Number(counts.media),pending:Number(counts.pending)};
    }
    const job = this.store.db.prepare('SELECT * FROM scan_jobs ORDER BY id DESC LIMIT 1').get() ?? null;
    const roots = this.store.db.prepare('SELECT id,name,state,error,scanned_at AS scannedAt FROM roots WHERE active=1 ORDER BY name,id').all().map(root => {
      const space = this.storageSpace.get(String(root.id));
      const available = space && space.path === this.definitions.find(item => item.id === root.id)?.path
        && (root.state === 'ready' || root.state === 'scanning');
      return { ...root, scanRequested: this.rootScans.has(String(root.id)),
        availableBytes: available ? space.availableBytes : null, totalBytes: available ? space.totalBytes : null };
    });
    return { ready: this.ready, scanning: !!this.pending, scanMode:this.pending?(this.fullScan?'full':'incremental'):null,
      inventory:{media:this.inventoryCache.media,pending:this.inventoryCache.pending},job, roots, watch: this.watchers?.status() ?? null,
      queuedDirectories: this.changes.size + this.automaticChanges.size + this.scheduler.queuedHints,
      errorDetailsTruncated: Number(job?.errors ?? 0) > 1000 };
  }
  errors(limit = 100, offset = 0) { return this.store.db.prepare('SELECT * FROM scan_errors WHERE job_id=(SELECT MAX(id) FROM scan_jobs) ORDER BY root_id,path LIMIT ? OFFSET ?').all(Math.min(200, Math.max(1, limit)), Math.max(0, offset)); }
  private entry(row: StoredMedia): LibraryEntry {
    const root = this.definitions.find(r => r.id === row.root_id)!;
    return { id: row.id, name: row.path, root: root.name, rootIndex: root.index, rootId: root.id, size: row.size, lastModified: row.modified, version: row.version, state: row.state };
  }
  private browseContext(query: BrowseQuery) {
    const revision = Number(this.store.db.prepare('SELECT revision FROM library_revision WHERE id=1').get()!.revision);
    if (query.revision !== undefined && query.revision !== revision) throw Object.assign(new Error('媒体库已更新，请从第一页重新浏览。'), { code: 'INDEX_CHANGED' });
    const limit = Math.min(200, Math.max(1, query.limit ?? 100)), offset = Math.max(0, query.offset ?? 0);
    const directory = query.directory ?? '';
    if (directory.startsWith('/') || directory.split('/').some(p => p === '..') || directory.includes('\\')) throw new Error('无效的媒体目录。');
    if (query.rootId && !this.definitions.some(r => r.id === query.rootId)) throw new Error('未知媒体根目录。');
    return { revision, limit, offset, directory };
  }
  /** Validate the same scope before conditional responses, without COUNT, sorting or loading rows. */
  browseEtag(query: BrowseQuery = {}) {
    const { revision, limit, offset, directory } = this.browseContext(query);
    const changes = this.store.db.prepare('SELECT total_changes() AS changes').get()!.changes;
    const external = this.store.db.prepare('PRAGMA data_version').get();
    return `"browse-${createHash('sha256').update(JSON.stringify([this.browseEpoch, revision, changes, external,
      query.rootId ?? '', directory, query.search ?? '', !!query.recursive, limit, offset, this.thumbnails.epoch, this.status()])).digest('base64url')}"`;
  }
  browse(query: BrowseQuery = {}) {
    const { revision, limit, offset, directory } = this.browseContext(query);
    const filters = ['r.active=1', "m.state!='missing'"], values: (string | number)[] = [];
    if (query.rootId) { filters.push('m.root_id=?'); values.push(query.rootId); }
    if (!query.recursive) { filters.push('m.parent=?'); values.push(directory); }
    else if (directory) { filters.push("substr(m.path,1,?)=?"); values.push(directory.length + 1, directory + '/'); }
    if (query.search) { filters.push('instr(lower(m.path),lower(?))>0'); values.push(query.search.slice(0, 300)); }
    const where = filters.join(' AND ');
    const total = (this.store.db.prepare(`SELECT COUNT(*) AS total FROM media m JOIN roots r ON r.id=m.root_id WHERE ${where}`).get(...values) as { total: number }).total;
    const rows = this.store.db.prepare(`SELECT m.* FROM media m JOIN roots r ON r.id=m.root_id WHERE ${where} ORDER BY m.path COLLATE NOCASE,m.path,m.root_id LIMIT ? OFFSET ?`).all(...values, limit, offset) as unknown as StoredMedia[];
    // Lightweight thumbnail presence for the current recipe, so lists render
    // cached covers without per-item HEAD requests. Exact (id, version)
    // matches only; a replaced file never inherits the old cover.
    const thumbKeys = this.thumbnails.readyKeys(rows.map(r => r.id), THUMB_RECIPE_VERSION);
    const entries = rows.map(r => {
      const entry = this.entry(r);
      return { ...entry, thumbnail: thumbKeys.has(`${entry.id}|${entry.version}`) };
    });
    // Folders have their own page so a large directory cannot bypass the media limit.
    const folders = query.recursive ? [] : this.store.db.prepare(`SELECT d.root_id AS rootId,d.path,d.name FROM directories d JOIN roots r ON r.id=d.root_id WHERE r.active=1 AND d.path!='' AND d.parent=? ${query.rootId ? 'AND d.root_id=?' : ''} ${query.search ? 'AND instr(lower(d.name),lower(?))>0' : ''} ORDER BY d.name COLLATE NOCASE,d.path,d.root_id LIMIT ? OFFSET ?`).all(directory, ...(query.rootId ? [query.rootId] : []), ...(query.search ? [query.search.slice(0, 300)] : []), limit + 1, offset);
    return { entries, directories: folders.slice(0, limit), moreDirectories: folders.length > limit, total, offset, limit, revision, nextOffset: offset + limit < total || folders.length > limit ? offset + limit : null, thumbnailEpoch: this.thumbnails.epoch, ...this.status() };
  }
  async list(force = false): Promise<Library> {
    if (force) await this.refresh();
    const rows = this.store.db.prepare("SELECT m.* FROM media m JOIN roots r ON r.id=m.root_id WHERE r.active=1 AND m.state!='missing' ORDER BY m.path COLLATE NOCASE,m.path,m.root_id LIMIT 5001").all() as unknown as StoredMedia[];
    return { roots: this.definitions.map(r => r.name), entries: rows.slice(0, 5000).map(r => this.entry(r)), truncated: rows.length > 5000 };
  }
  refresh(): Promise<void> {
    if (this.configuring) return Promise.reject(new Error('媒体目录配置正在更新。'));
    if (this.closed) return Promise.reject(new Error('媒体索引已关闭。'));
    if (!this.pending && this.storageReads.size) {
      const generation = this.cancelGeneration;
      return Promise.allSettled([...this.storageReads]).then(() => { if (generation === this.cancelGeneration) return this.refresh(); });
    }
    if (this.pending) {
      const generation = this.cancelGeneration;
      return this.fullScan ? this.pending : this.pending.then(() => { if (generation === this.cancelGeneration) return this.refresh(); });
    }
    this.resumeAt = 0;
    this.changes.clear(); this.settling.clear();
    return this.runScan();
  }
  /** Internal/admin callers use verified root IDs and relative directories.
   * Reconcile only these subtrees; overlapping requests are merged. */
  refreshRoot(rootId: string): Promise<void> {
    const existing=this.rootScans.get(rootId);
    if (existing) return existing;
    const pending=this.refreshScopes([{rootId,directory:''}],true);
    this.rootScans.set(rootId,pending);
    void pending.then(() => this.rootScans.delete(rootId),() => this.rootScans.delete(rootId));
    return pending;
  }
  refreshDirectories(scopes: DirectoryScope[]) { return this.refreshScopes(scopes); }
  private async refreshScopes(scopes: DirectoryScope[], rootOnly = false) {
    if (this.configuring) throw new Error('媒体目录配置正在更新。');
    if (this.closed) throw new Error('媒体索引已关闭。');
    if (rootOnly && this.options.scan) throw new Error('当前扫描适配器不支持单目录扫描。');
    const generation = this.cancelGeneration;
    for (const scope of scopes) {
      if (!this.definitions.some(r => r.id === scope.rootId) || scope.directory.startsWith('/') || scope.directory.includes('\\') || scope.directory !== '' && scope.directory.split('/').some(p => !p || p.startsWith('.'))) throw new Error('无效的媒体目录。');
    }
    for (const scope of scopes) this.changes.add(scope);
    while (this.pending || this.storageReads.size) {
      await (this.pending ?? Promise.allSettled([...this.storageReads]));
      if (generation !== this.cancelGeneration) return;
    }
    if (!this.changes.size) return;
    if (!rootOnly && (!this.ready || this.options.scan)) return this.refresh();
    return this.runScan(this.changes.take());
  }
  private scheduleChanges() {
    if (this.changeTimer || this.pending || this.storageReads.size || this.closed || this.stopped) return;
    // A fixed batching window also bounds latency under continuous writes.
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (this.pending || this.storageReads.size || this.closed || this.stopped) return;
      if (this.started) {
        for (const scope of this.automaticChanges.take()) this.scheduler.hint(scope);
        this.scheduleAutomatic();
      } else void this.runScan(this.automaticChanges.take(), true).catch(() => {});
    }, this.options.debounceMs ?? 350);
    this.changeTimer.unref();
  }
  private runScan(scopes?: DirectoryScope[], shallow = false) {
    const controller = this.abort = new AbortController();
    this.fullScan = !scopes;
    this.pending = this.scan(controller.signal, scopes, shallow).catch(error => {
      if (shallow) for (const scope of scopes ?? []) this.scheduler.finish(scope, false);
      throw error;
    }).finally(() => {
      this.pending = null; this.abort = null;
      if (this.automaticChanges.size) this.scheduleChanges();
      this.scheduleAutomatic();
    });
    return this.pending;
  }
  cancel() {
    this.cancelGeneration++;
    this.abort?.abort();
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    if (this.changeTimer) { clearTimeout(this.changeTimer); this.changeTimer = null; }
    this.changes.clear(); this.automaticChanges.clear(); this.settling.clear();
    this.scheduler.clear(); this.resumeAt = this.now() + (this.options.ttlMs ?? LIBRARY_RECHECK_MS);
  }
  stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.watchers?.close(); }
    finally { this.watchers = null; this.cancel(); }
  }
  private async io<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.storageReads.add(operation);
    const drained = () => {
      this.storageReads.delete(operation);
      if (this.automaticChanges.size) this.scheduleChanges();
      this.scheduleAutomatic();
    };
    void operation.then(drained, drained);
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
  /** A disconnected mount can expose a readable, empty directory underneath.
   * Persist the filesystem type, not st_dev: remounting can change device IDs.
   * The numeric type is OS-specific and is never compared across platforms. */
  private async checkStorage(root: RootRecord, signal?: AbortSignal, learn = false) {
    const prior = this.store.db.prepare('SELECT path,platform,fs_type FROM root_storage WHERE root_id=?').get(root.id) as { path: string; platform: string; fs_type: string } | undefined;
    const current = await this.io(fs.statfs(root.path), signal);
    const bound = !!prior?.fs_type && prior.path === root.path;
    if (bound && (prior.platform !== process.platform || prior.fs_type !== String(current.type))) {
      throw Object.assign(new Error('媒体根目录的文件系统已改变，请恢复原存储挂载'), { code: 'ESTORAGECHANGED' });
    }
    const totalBytes = current.blocks * current.bsize, availableBytes = Math.max(0, Math.min(current.bavail, current.blocks)) * current.bsize;
    if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(availableBytes)) {
      this.storageSpace.set(root.id, { path: root.path, availableBytes, totalBytes });
    } else this.storageSpace.delete(root.id);
    if (learn && !bound) {
      this.store.db.prepare('INSERT INTO root_storage(root_id,path,platform,fs_type) VALUES(?,?,?,?) ON CONFLICT(root_id) DO UPDATE SET path=excluded.path,platform=excluded.platform,fs_type=excluded.fs_type').run(root.id, root.path, process.platform, String(current.type));
    }
    return learn || bound;
  }
  private async scan(signal: AbortSignal, scopes?: DirectoryScope[], shallow = false) {
    const db = this.store.db;
    const job = Number(db.prepare("INSERT INTO scan_jobs(state,started_at) VALUES('running',?)").run(this.now()).lastInsertRowid);
    let visited = 0, files = 0, errors = 0, reads = 0, entries = 0;
    const progress = (root?: string, directory?: string) => db.prepare('UPDATE scan_jobs SET visited=?,files=?,errors=?,current_root=?,current_path=? WHERE id=?').run(visited, files, errors, root ?? null, directory ?? null, job);
    const upsert = db.prepare(`INSERT INTO media(id,root_id,path,parent,size,modified,version,state,generation,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET size=excluded.size,modified=excluded.modified,version=excluded.version,state=excluded.state,generation=excluded.generation,observed_at=CASE WHEN media.version=excluded.version THEN media.observed_at ELSE excluded.observed_at END`);
    const findId = db.prepare('SELECT id FROM media WHERE root_id=? AND path=?');
    const alias = db.prepare('INSERT INTO aliases(id,media_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET media_id=excluded.media_id');
    const priorVersion = db.prepare('SELECT version,state,observed_at FROM media WHERE root_id=? AND path=?');
    const insertDirectory = db.prepare('INSERT OR IGNORE INTO directories(root_id,path,parent,name,generation) VALUES(?,?,?,?,?)');
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
      const relocation=this.relocations, cover=relocation?.find(root.id,relative,version);
      writes.push(() => {
        upsert.run(mediaId(root.seed, relative), root.id, relative, parent(relative), size, modified, version, state, job, observedAt);
        const record = findId.get(root.id, relative) as { id: string };
        alias.run(mediaId(root.path, relative), record.id);
        if (state==='ready'&&cover) this.thumbnails.copyRelocated(cover.id,cover.version,record.id,version,relocation!.epoch);
      });
      if (writes.length >= 64) flush();
    };
    const errorAt = (root: RootRecord, relative: string, error: unknown) => {
      if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
      const code = String((error as NodeJS.ErrnoException).code ?? 'IO_ERROR'); errors++;
      if (errors <= 1000) db.prepare('INSERT INTO scan_errors(job_id,root_id,path,code,message) VALUES(?,?,?,?,?)').run(job, root.id, relative, code, code === 'ESTORAGECHANGED' ? '文件系统已改变，保留索引并等待原存储挂载恢复' : code === 'ESTORAGEUNVERIFIED' ? '升级后尚未核对到原媒体，保留索引并等待存储恢复' : '无法读取媒体存储');
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
        const directories = scopes ? scopes.filter(s => s.rootId === root.id).map(s => s.directory) : [''];
        if (!directories.length) continue;
        const wholeRoot = directories.includes('');
        if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
        const errorsBefore = errors;
        const previous = db.prepare('SELECT state,error,scanned_at FROM roots WHERE id=?').get(root.id)!;
        db.prepare("UPDATE roots SET state='scanning',error=NULL WHERE id=?").run(root.id);
        if (wholeRoot && !shallow) this.watchers?.beginRoot(root.id);
        if (wholeRoot && shallow) this.watchers?.retryRoot(root.id);
        let offline = false;
        let rootReal = '';
        let storageVerified = false;
        const bound = db.prepare('SELECT path FROM root_storage WHERE root_id=?').get(root.id);
        const mayBindEmpty = !!bound && bound.path !== root.path || !db.prepare("SELECT 1 FROM media WHERE root_id=? AND state!='missing' LIMIT 1").get(root.id);
        try { rootReal = await this.io(fs.realpath(root.path), signal); storageVerified = await this.checkStorage(root, signal); }
        catch (error) { errorAt(root, '', error); offline = true; this.watchers?.resetRoot(root.id); }
        for (const directory of offline ? [] : directories) {
          const scopeErrorsBefore = errors;
          const scope = { rootId: root.id, directory };
          const seenMedia = new Set<string>(), seenDirectories = new Set<string>();
          let unverifiedFiles = false;
          const stack = [directory];
          while (stack.length) {
            const relative = stack.pop()!;
            progress(root.id, relative);
            let children;
            try {
              // readdir is async: slow/network storage does not occupy the HTTP loop.
              const absolute = await this.io(fs.realpath(path.join(rootReal, relative)), signal);
              if (absolute !== path.join(rootReal, relative)) throw Object.assign(new Error('目录离开白名单'), { code: 'EPERM' });
              if (this.watchers) {
                const stat = await this.io(fs.stat(absolute), signal);
                this.watchers.add({ rootId: root.id, directory: relative }, absolute, `${absolute}:${stat.dev}:${stat.ino}`);
              }
              children = await this.io(fs.readdir(absolute, { withFileTypes: true }), signal);
              storageVerified = await this.checkStorage(root, signal, mayBindEmpty);
            } catch (error) { errorAt(root, relative, error); if (!relative || (error as NodeJS.ErrnoException).code === 'ESTORAGECHANGED') offline = true; continue; }
            visited++;
            db.prepare('INSERT INTO directories(root_id,path,parent,name,generation) VALUES(?,?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET generation=excluded.generation').run(root.id, relative, parent(relative), path.posix.basename(relative), job);
            this.scheduler.remember({ rootId: root.id, directory: relative });
            for (const child of children) {
              if (++entries % 64 === 0) {
                flush(); progress(root.id, relative);
                await new Promise<void>(resolve => setImmediate(resolve));
              }
              if (signal.aborted) throw new DOMException('扫描已取消', 'AbortError');
              if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
              const name = relative ? relative + '/' + child.name : child.name;
              if (child.isDirectory()) {
                if (shallow) {
                  seenDirectories.add(name);
                  writes.push(() => {
                    insertDirectory.run(root.id, name, relative, child.name, job);
                    this.scheduler.remember({ rootId: root.id, directory: name });
                  });
                  if (writes.length >= 64) flush();
                } else stack.push(name);
                continue;
              }
              if (!child.isFile() || !MEDIA_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
              if (shallow && reads++ % 8 === 0 && reads > 1) {
                await this.io(new Promise<void>(resolve => setTimeout(resolve, this.options.scanBatchDelayMs ?? 25)), signal);
              }
              let stat: Stats;
              try { stat = await this.io(fs.lstat(path.join(rootReal, name)), signal); }
              catch (error) { errorAt(root, name, error); continue; }
              if (!stat.isFile() || stat.isSymbolicLink()) continue;
              const version = fileVersion(stat), settleMs = this.options.settleMs ?? 0;
              const prior = priorVersion.get(root.id, name) as { version: string; state: string; observed_at: number } | undefined;
              // Schema 1 had no filesystem binding. Require one unchanged known
              // file before accepting a first binding for an existing library.
              if (!storageVerified && prior?.version === version) storageVerified = await this.checkStorage(root, signal, true);
              if (!storageVerified) { unverifiedFiles = true; continue; }
              const relocated=this.relocations?.find(root.id,name,version);
              const pending = !relocated && settleMs > 0 && (prior?.version === version ? prior.state === 'pending' && this.now() - prior.observed_at < settleMs : !!prior || this.now() - stat.mtimeMs < settleMs);
              if (pending) this.settling.add({ rootId: root.id, directory: relative });
              // Database errors fail the job, rather than being treated as a bad file.
              const state = pending ? 'pending' : 'ready';
              seenMedia.add(name);
              if (!shallow || prior?.version !== version || prior.state !== state
                || !db.prepare('SELECT 1 FROM aliases WHERE id=?').get(mediaId(root.path, name)))
                put(root, name, stat.size, Math.round(stat.mtimeMs), version, state);
              files++;
            }
          }
          flush();
          try { if (!await this.checkStorage(root, signal)) throw Object.assign(new Error('尚未核对原媒体存储'), { code: 'ESTORAGEUNVERIFIED' }); }
          catch (error) {
            errorAt(root, directory, error);
            // Legacy bindings may need an unchanged file in a deeper directory
            // before storage can be verified. Keep that bounded discovery alive.
            if (!shallow || (error as NodeJS.ErrnoException).code !== 'ESTORAGEUNVERIFIED') offline = true;
          }
          if (unverifiedFiles && storageVerified) {
            errorAt(root, directory, { code: 'ERECHECK' });
            this.automaticChanges.add({ rootId: root.id, directory });
          }
          // Reconcile only successfully inspected subtrees. An incomplete scope
          // must not delete old records, and an incremental scan cannot touch its siblings.
          if (errors === scopeErrorsBefore) {
            if (shallow) {
              const existing = db.prepare("SELECT path FROM media WHERE root_id=? AND parent=? AND state!='missing'").all(root.id, directory);
              for (const row of existing) if (!seenMedia.has(String(row.path)))
                db.prepare("UPDATE media SET state='missing' WHERE root_id=? AND path=?").run(root.id, row.path);
              const children = db.prepare("SELECT path FROM directories WHERE root_id=? AND parent=? AND path!=''").all(root.id, directory);
              for (const row of children) if (!seenDirectories.has(String(row.path))) {
                const name = String(row.path), prefix = name + '/';
                db.prepare("UPDATE media SET state='missing' WHERE root_id=? AND state!='missing' AND substr(path,1,?)=?")
                  .run(root.id, prefix.length, prefix);
                db.prepare('DELETE FROM directories WHERE root_id=? AND (path=? OR substr(path,1,?)=?)')
                  .run(root.id, name, prefix.length, prefix);
                this.scheduler.prune({ rootId: root.id, directory: name });
              }
            } else {
              const prefix = directory + '/';
              const within = directory ? ' AND (path=? OR substr(path,1,?)=?)' : '';
              const values = directory ? [directory, prefix.length, prefix] : [];
              db.prepare("UPDATE media SET state='missing' WHERE root_id=? AND generation!=?" + within).run(root.id, job, ...values);
              db.prepare('DELETE FROM directories WHERE root_id=? AND generation!=?' + within).run(root.id, job, ...values);
              this.scheduler.prune(scope);
            }
            if (this.watchers) {
              const exists = db.prepare('SELECT 1 FROM directories WHERE root_id=? AND path=?');
              this.watchers.prune({ rootId: root.id, directory }, name => !!exists.get(root.id, name));
            }
          }
          this.scheduler.finish(scope, errors === scopeErrorsBefore, !shallow && errors === scopeErrorsBefore);
        }
        if (offline) {
          this.scheduler.finish({ rootId: root.id, directory: '' }, false);
          for (const directory of directories) this.scheduler.finish({ rootId: root.id, directory }, false);
        }
        if (wholeRoot && !shallow) this.watchers?.finishRoot(root.id, errors === errorsBefore);
        db.prepare('UPDATE roots SET state=?,error=?,scanned_at=? WHERE id=?').run(
          offline ? 'offline' : errors > errorsBefore ? 'partial' : wholeRoot ? 'ready' : previous.state,
          errors > errorsBefore ? '部分路径不可读取，查看扫描错误' : wholeRoot ? null : previous.error,
          wholeRoot && !shallow ? this.now() : previous.scanned_at, root.id);
      }
      this.initialized = true; progress();
      db.prepare("UPDATE scan_jobs SET state=?,finished_at=? WHERE id=?").run(errors ? 'partial' : 'completed', this.now(), job);
      db.prepare('DELETE FROM scan_errors WHERE job_id IN (SELECT id FROM scan_jobs ORDER BY id DESC LIMIT -1 OFFSET 50)').run();
      db.prepare('DELETE FROM scan_jobs WHERE id IN (SELECT id FROM scan_jobs ORDER BY id DESC LIMIT -1 OFFSET 50)').run();
      if (this.started) this.settling.clear();
      if (this.settling.size && !this.settleTimer && !this.closed && !this.stopped) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          for (const scope of this.settling.take()) this.automaticChanges.add(scope);
          this.scheduleChanges();
        }, this.options.settleMs ?? 1000); this.settleTimer.unref();
      }
    } catch (error) {
      progress();
      db.prepare('UPDATE scan_jobs SET state=?,finished_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', this.now(), job);
      db.prepare("UPDATE roots SET state=? WHERE active=1 AND state='scanning'").run(signal.aborted ? 'cancelled' : 'error');
      if (!signal.aborted) throw error;
    }
  }
  metadata(id: string) {
    const row = this.store.find(id);
    if (!row) return null;
    const entry = this.entry(row);
    let thumbnail = false;
    try {
      thumbnail = entry.version ? this.thumbnails.status(entry.id, entry.version, THUMB_RECIPE_VERSION).ready : false;
    } catch { /* Thumbnail presence is advisory; metadata must still load. */ }
    return { ...entry, thumbnail, thumbnailEpoch: this.thumbnails.epoch };
  }
  async resolve(id: string, version?: string): Promise<string | null> {
    if (!/^[0-9a-f]{24}$/.test(id) || this.closed) return null;
    const entry = this.store.find(id);
    if (!entry || entry.state !== 'ready' || (version && version !== entry.version)) return null;
    const root = this.definitions.find(r => r.id === entry.root_id);
    if (!root) return null;
    try {
      await this.checkStorage(root);
      const rootReal = await this.io(fs.realpath(root.path));
      const real = await this.io(fs.realpath(path.join(rootReal, entry.path)));
      if (!real.startsWith(rootReal + path.sep)) return null;
      const stat = await this.io(fs.stat(real));
      if (!stat.isFile() || fileVersion(stat) !== entry.version) return null;
      return real;
    } catch { return null; }
  }
  async mutateFiles(body:unknown):Promise<LibraryFileResult> {
    if (this.closed||this.configuring||this.fileMutation) throw new AdminError(409,'媒体库正在处理其他文件操作或配置变更。','library-files-busy');
    const command=parseLibraryFileCommand(body);
    const operation=(async () => {
      const sources=command.operation==='rename'?[command.source]:command.sources;
      const ids=new Set([...sources.map(source => source.rootId),...(command.operation==='move'?[command.target.rootId]:[])]);
      for (const id of ids) {
        const root=this.definitions.find(root => root.id===id);
        if (!root) throw new AdminError(404,'媒体库不存在。');
        if (!await this.checkStorage(root)) throw new AdminError(409,'媒体库挂载尚未核验。');
      }
      let relocations:LibraryRelocations|undefined;
      try {
        const mutation=await mutateLibraryFiles(this.definitions,command,fileVersion,() => {
          relocations=new LibraryRelocations(this.store.db,command,this.thumbnails.epoch);
        });
        relocations!.approve(mutation);this.relocations=relocations;
        let indexRefreshed=true;
        const generation=this.cancelGeneration;
        try {await this.refreshDirectories(mutation.scopes);indexRefreshed=!this.closed&&generation===this.cancelGeneration;}
        catch {indexRefreshed=false;}
        return {results:mutation.results,indexRefreshed};
      } finally {this.relocations=undefined;relocations?.dispose();}
    })();
    this.fileMutation=operation;
    try {return await operation;} finally {this.fileMutation=undefined;}
  }
  private indexReaders = new Set<()=>Promise<void>>();
  registerIndexReader(stop:()=>Promise<void>) {
    if (this.closed) throw new AdminError(503, '服务正在关闭。', 'service-closed');
    let stopped:Promise<void>|undefined;
    const close=()=>stopped??=Promise.resolve().then(stop);
    this.indexReaders.add(close);
    return close;
  }
  close(ownersStopped?:Promise<void>){return this.closing??=this.closeMedia(ownersStopped);}
  stopExecution(){return this.stopping??=(async()=>{
    this.closed=true;
    await closeResources('Media execution shutdown incomplete',[
      ['library file operations',()=>this.fileMutation?.catch(()=>{})],
      ['scan scheduling',()=>this.stop()],['library scan',()=>this.pending?.catch(()=>{})],
      ['storage reads',async()=>{await Promise.allSettled([...this.storageReads]);}],
      ['index readers',()=>closeResources('Index readers failed to stop',[...this.indexReaders].map((stop,i)=>[String(i),stop] as const))],['index executors',()=>this.indexJobs.close()],
    ]);
  })();}
  releaseStorage(){this.store.close();}
  private async closeMedia(external?:Promise<void>){
    await closeResources('Media shutdown incomplete; database ownership retained',[['media execution',()=>this.stopExecution()],['external owners',()=>external]]);
    this.releaseStorage();
  }
  /** Serialize configuration with scans. Persist first; a failed DB switch rolls
   * back the file before allowing scans again. Existing byte streams stay open. */
  async reconfigure(roots: MediaRoot[], persist: () => Promise<() => Promise<void>>) {
    if (this.closed || this.configuring || this.fileMutation) throw new AdminError(409,'媒体目录配置正在更新、文件操作未完成或服务已关闭。');
    const definitions = normalizeRoots(roots);
    this.configuring = true;
    const restart = this.started;
    this.stop();
    try {
      await this.pending;
      await Promise.allSettled([...this.storageReads]);
      const rollback = await persist();
      try { this.store.configure(definitions); }
      catch (error) { await rollback(); throw error; }
      this.storageSpace.clear();
      this.definitions.splice(0, this.definitions.length, ...definitions);
      this.roots.splice(0, this.roots.length, ...definitions.map(r => r.path));
    } finally {
      this.configuring = false;
      if (restart && !this.closed) this.start();
    }
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
