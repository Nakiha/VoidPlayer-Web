import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openIndexDatabase } from './sqlite.ts';
import type { IndexDatabase } from './sqlite.ts';
import type { Actor } from './identity.ts';
import { AdminError } from './admin-error.ts';
import { parseWorkspace } from '../src/workspace-file.ts';
import type { WorkspaceFile } from '../src/workspace-file.ts';

export const WORKSPACE_BYTES = 32 * 1024 * 1024;
export type SavedWorkspace = { id: string; name: string; owner: string; ownerName?: string; createdAt: string; updatedAt: string; updatedBy: string; revision: number; bytes: number; tracks: number; marks: number };
const columns = 'id,name,owner,created_at AS createdAt,updated_at AS updatedAt,updated_by AS updatedBy,revision,bytes,tracks,marks';
/** User-authored documents are separate from the rebuildable media index.
 * SQLite transactions commit metadata, content and revision together. */
export class WorkspaceStore {
  private db: IndexDatabase;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = this.db = openIndexDatabase(file);
    try {
      if (file !== ':memory:') chmodSync(file, 0o600);
      db.exec('PRAGMA busy_timeout=3000');
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 3) throw new Error('工作区数据库来自更新的程序，请恢复匹配的程序版本。');
      db.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,revision INTEGER NOT NULL,bytes INTEGER NOT NULL,tracks INTEGER NOT NULL,marks INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS workspace_owner ON workspaces(owner,updated_at,id);
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);

        `);
      if (version.user_version < 2) db.exec('INSERT OR IGNORE INTO users(id,name) SELECT DISTINCT owner,owner FROM workspaces');
      if (version.user_version < 3) db.exec(`ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'named';
        UPDATE users SET kind='guest' WHERE name GLOB '用户-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]';`);
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_shares(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,owner TEXT NOT NULL,document TEXT NOT NULL); PRAGMA user_version=3; COMMIT;`);
    } catch (error) { db.close(); throw error; }
  }
  users(): Actor[] { return (this.db.prepare("SELECT id,name FROM users WHERE kind='named' ORDER BY name,id").all() as Actor[]).map(row => ({ ...row })); }
  user(id: string | undefined): Actor | null {
    const row = id ? this.db.prepare('SELECT id,name,kind FROM users WHERE id=?').get(id) as Actor | undefined : undefined;
    return row ? { id: row.id, name: row.kind === 'guest' ? '访客' : row.name, ...(row.kind === 'guest' ? {kind: 'guest' as const} : {}) } : null;
  }
  /** A name is a trusted identity claim, not a credential. Keep IDs stable on rename. */
  identify(id?: string, value?: unknown, mode: 'claim' | 'rename' | 'create' = 'claim'): Actor {
    let name: string | undefined;
    if (value === undefined) throw new AdminError(400, '请填写用户名或选择访客。');
    if (value !== undefined) {
      if (typeof value !== 'string') throw new AdminError(400, '用户名需要 1–128 个字符。');
      name = value.normalize('NFC').trim();
      if (!name || name.length > 128 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new AdminError(400, '用户名需要 1–128 个字符，不能包含控制字符。');
    }
    // Serialize lookup + rename/create across connections; UNIQUE is the final guard.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let actor = name ? this.db.prepare('SELECT id,name FROM users WHERE name=?').get(name) as Actor | undefined : undefined;
      if (mode === 'rename' && !this.user(id)) throw new AdminError(400, '请先选择要修改名字的用户。');
      if (actor && (mode === 'create' || (mode === 'rename' && actor.id !== id))) throw new AdminError(409, '这个名字已被使用，请换一个名字，或通过切换用户选择已有用户。');
      if (!actor) {
        actor = this.user(mode === 'create' ? undefined : id) ?? undefined;
        if (actor && name) { this.db.prepare("UPDATE users SET name=?,kind='named' WHERE id=?").run(name, actor.id); actor = { id: actor.id, name }; }
        if (!actor) {
          const nextId = randomUUID();
          actor = { id: nextId, name: name! };
          this.db.prepare('INSERT INTO users(id,name) VALUES(?,?)').run(actor.id, actor.name);
        }
      }
      this.db.prepare("UPDATE users SET kind='named' WHERE id=?").run(actor.id);
      this.db.exec('COMMIT'); return { ...actor };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(actor: Actor, all: boolean, before = '', search = '') {
    if (before && !/^\d{4}-\d{2}-\d{2}T[0-9:.Z-]+\|[a-f0-9-]{36}$/.test(before)) throw new AdminError(400, '工作区分页位置无效。');
    if (search.length > 200) throw new AdminError(400, '搜索文本过长。');
    const conditions = [], values: string[] = [];
    if (!all) { conditions.push('owner=?'); values.push(actor.id); }
    if (search) { conditions.push('(instr(lower(name),lower(?))>0 OR owner IN (SELECT id FROM users WHERE instr(lower(name),lower(?))>0))'); values.push(search, search); }
    if (before) { const [time, id] = before.split('|'); conditions.push('(updated_at<? OR (updated_at=? AND id<?))'); values.push(time, time, id); }
    const rows = this.db.prepare(`SELECT ${columns},COALESCE((SELECT name FROM users WHERE users.id=workspaces.owner),'访客') AS ownerName FROM workspaces ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY updated_at DESC,id DESC LIMIT 41`).all(...values) as unknown as SavedWorkspace[];
    const entries = rows.slice(0, 40), last = entries.at(-1);
    return { entries, next: rows.length > 40 && last ? `${last.updatedAt}|${last.id}` : null };
  }
  private row(id: string, content = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AdminError(404, '工作区不存在。');
    const row = this.db.prepare(`SELECT ${columns},COALESCE((SELECT name FROM users WHERE users.id=workspaces.owner),'访客') AS ownerName${content ? ",document" : ""} FROM workspaces WHERE id=?`).get(id) as unknown as (SavedWorkspace & { document?: string }) | undefined;
    if (!row) throw new AdminError(404, '工作区不存在。');
    return row;
  }
  read(id: string, _actor: Actor) {
    const { document, ...metadata } = this.row(id, true);
    return { ...metadata, document: JSON.parse(document!) as WorkspaceFile };
  }
  private input(value: unknown) {
    const input = value as { name?: unknown; document?: unknown } | null;
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) throw new AdminError(400, '工作区名称需要 1–200 个字符。');
    let document: WorkspaceFile;
    try { document = parseWorkspace(input.document); } catch (error) { throw new AdminError(400, (error as Error).message); }
    const json = JSON.stringify(document), bytes = Buffer.byteLength(json);
    if (bytes > WORKSPACE_BYTES) throw new AdminError(413, '工作区内容超过 32 MiB。');
    return { name: input.name.trim(), document, json, bytes };
  }
  create(value: unknown, actor: Actor) {
    const input = this.input(value), id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, input.name, actor.id, now, now, actor.id, 1, input.bytes, input.document.tracks.length, input.document.marks.length, input.json);
    return this.row(id);
  }
  update(id: string, revision: string | undefined, value: unknown, actor: Actor) {
    const row = this.row(id); this.match(row, revision);
    const input = this.input(value), now = new Date().toISOString();
    const changed = this.db.prepare('UPDATE workspaces SET name=?,updated_at=?,updated_by=?,revision=revision+1,bytes=?,tracks=?,marks=?,document=? WHERE id=? AND revision=?').run(input.name, now, actor.id, input.bytes, input.document.tracks.length, input.document.marks.length, input.json, id, row.revision);
    if (!changed.changes) throw new AdminError(409, '工作区已更新，请载入服务器版本或另存为副本。');
    return this.row(id);
  }
  remove(id: string, revision: string | undefined, actor: Actor) {
    const row = this.row(id); this.match(row, revision);
    const changed = this.db.prepare('DELETE FROM workspaces WHERE id=? AND revision=?').run(id, row.revision);
    if (!changed.changes) throw new AdminError(409, '工作区已改变，请重新载入后再删除。');
    return { ok: true };
  }
  private match(row: SavedWorkspace, revision?: string) {
    if (!revision) throw new AdminError(428, '此操作需要工作区版本。');
    if (revision !== `"${row.revision}"`) throw new AdminError(409, '工作区已更新，请载入服务器版本或另存为副本。');
  }
  share(value: unknown, actor: Actor | null) {
    const input = this.input({ name: '分享快照', document: value });
    if (!input.document.tracks.length) throw new AdminError(400, '请先添加视频再分享。');
    for (const media of input.document.media) {
      if (!media.source) throw new AdminError(400, `「${media.name}」是本地文件，请先放入服务端媒体库再分享。`);
      if (!/^[0-9a-f]{24}$/.test(new URL(media.source.url).searchParams.get('v') ?? '')) throw new AdminError(400, '分享片源必须固定媒体库版本。');
    }
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO workspace_shares VALUES(?,?,?,?)').run(id, createdAt, actor?.id ?? 'guest', input.json);
    return { id, createdAt };
  }
  shared(id: string) {
    const row = this.db.prepare('SELECT document FROM workspace_shares WHERE id=?').get(id) as {document:string} | undefined;
    if (!row) throw new AdminError(404, '分享链接不存在或已被移除。');
    return { document: JSON.parse(row.document) as WorkspaceFile };
  }
  close() { this.db.close(); }
}
