import { openIndexDatabase } from './sqlite.ts';
import type { IndexDatabase } from './sqlite.ts';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type MediaRoot = string | { id: string; path: string; name?: string };
export interface RootRecord { id: string; path: string; name: string; index: number; seed: string }
export function mediaId(root: string, relative: string) { return createHash('sha256').update(`${root}\n${relative}`).digest('hex').slice(0, 24); }
export function normalizeRoots(roots: MediaRoot[]): RootRecord[] {
  const normalized = roots.map((root, index) => {
    const directory = path.resolve(typeof root === 'string' ? root : root.path);
    return { id: typeof root === 'string' ? mediaId('root', directory) : root.id, path: directory, name: typeof root === 'string' ? path.basename(directory) : root.name || path.basename(directory), index, seed: typeof root === 'string' ? directory : `root:${root.id}` };
  });
  if (new Set(normalized.map(r => r.id)).size !== normalized.length || new Set(normalized.map(r => r.path)).size !== normalized.length) throw new Error('媒体根目录的 ID 和路径不能重复。');
  return normalized;
}
export interface StoredMedia { id: string; root_id: string; path: string; size: number; modified: number; version: string; state: string; generation: number; observed_at: number }
// A separate SQLite transaction is a crash-released OS file lock. It avoids
// stale PID files and never blocks readers of the actual metadata database.
function lockDatabase(file: string): () => void {
  if (file === ':memory:') return () => {};
  const lock = openIndexDatabase(file + '.lock');
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch (error) { lock.close(); if (/locked|busy/i.test((error as Error).message)) throw new Error('另一个实例正在使用媒体索引，请使用不同的数据目录。'); throw error; }
  return () => { try { lock.exec('ROLLBACK'); } finally { lock.close(); } };
}
export class LibraryStore {
  readonly db: IndexDatabase;
  private unlock: () => void;
  constructor(file = ':memory:') {
    this.unlock = lockDatabase(file);
    let connection: IndexDatabase | undefined;
    try {
      this.db = connection = openIndexDatabase(file);
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 2) { throw new Error('媒体索引来自更新的程序版本，请使用匹配版本或恢复升级前备份。'); }
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unscanned', error TEXT, scanned_at INTEGER);
        CREATE TABLE IF NOT EXISTS directories (root_id TEXT NOT NULL REFERENCES roots(id), path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(root_id,path));
        CREATE INDEX IF NOT EXISTS directory_parent ON directories(root_id,parent,name);
        CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), path TEXT NOT NULL, parent TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL, observed_at INTEGER NOT NULL, UNIQUE(root_id,path));
        CREATE INDEX IF NOT EXISTS media_parent ON media(root_id,parent,path);
        CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id));
        CREATE TABLE IF NOT EXISTS scan_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, visited INTEGER NOT NULL DEFAULT 0, files INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, current_root TEXT, current_path TEXT);
        CREATE TABLE IF NOT EXISTS scan_errors (job_id INTEGER NOT NULL REFERENCES scan_jobs(id), root_id TEXT NOT NULL, path TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS library_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS root_storage (root_id TEXT PRIMARY KEY REFERENCES roots(id), path TEXT NOT NULL, platform TEXT NOT NULL, fs_type TEXT NOT NULL);
        ${version.user_version < 2 ? "INSERT OR IGNORE INTO root_storage(root_id,path,platform,fs_type) SELECT id,path,'','' FROM roots;" : ''}
        INSERT OR IGNORE INTO library_revision VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS media_added AFTER INSERT ON media BEGIN UPDATE library_revision SET revision=revision+1; END;
        CREATE TRIGGER IF NOT EXISTS media_changed AFTER UPDATE ON media WHEN old.version!=new.version OR old.state!=new.state BEGIN UPDATE library_revision SET revision=revision+1; END;
        CREATE TRIGGER IF NOT EXISTS directory_added AFTER INSERT ON directories BEGIN UPDATE library_revision SET revision=revision+1; END;
        CREATE TRIGGER IF NOT EXISTS directory_removed AFTER DELETE ON directories BEGIN UPDATE library_revision SET revision=revision+1; END;
        CREATE TRIGGER IF NOT EXISTS root_changed AFTER UPDATE ON roots WHEN old.active!=new.active OR old.path!=new.path OR old.name!=new.name BEGIN UPDATE library_revision SET revision=revision+1; END;
        PRAGMA user_version=2;
        COMMIT;
      `);
      this.db.prepare("UPDATE scan_jobs SET state='interrupted', finished_at=? WHERE state='running'").run(Date.now());
    } catch (error) { try { connection?.close(); } catch {} this.unlock(); throw error; }
  }
  configure(roots: RootRecord[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('UPDATE roots SET active=0');
      const statement = this.db.prepare('INSERT INTO roots(id,path,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name,active=1');
      for (const root of roots) statement.run(root.id, root.path, root.name);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  find(id: string) { return this.db.prepare('SELECT media.* FROM media JOIN roots ON roots.id=media.root_id WHERE roots.active=1 AND (media.id=? OR media.id=(SELECT media_id FROM aliases WHERE id=?))').get(id, id) as unknown as StoredMedia | undefined; }
  close() { try { this.db.close(); } finally { this.unlock(); } }
}
