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
export type SavedWorkspace = { id: string; name: string; owner: string; createdAt: string; updatedAt: string; updatedBy: string; revision: number; bytes: number; tracks: number; marks: number };
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
      if (version.user_version > 1) throw new Error('工作区数据库来自更新的程序，请恢复匹配的程序版本。');
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,revision INTEGER NOT NULL,bytes INTEGER NOT NULL,tracks INTEGER NOT NULL,marks INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS workspace_owner ON workspaces(owner,updated_at,id);
        PRAGMA user_version=1;`);
    } catch (error) { db.close(); throw error; }
  }
  list(actor: Actor, all: boolean, before = '', search = '') {
    if (before && !/^\d{4}-\d{2}-\d{2}T[0-9:.Z-]+\|[a-f0-9-]{36}$/.test(before)) throw new AdminError(400, '工作区分页位置无效。');
    if (search.length > 200) throw new AdminError(400, '搜索文本过长。');
    const conditions = [], values: string[] = [];
    if (!all) { conditions.push('owner=?'); values.push(actor.id); }
    if (search) { conditions.push('instr(lower(name),lower(?))>0'); values.push(search); }
    if (before) { const [time, id] = before.split('|'); conditions.push('(updated_at<? OR (updated_at=? AND id<?))'); values.push(time, time, id); }
    const rows = this.db.prepare(`SELECT ${columns} FROM workspaces ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY updated_at DESC,id DESC LIMIT 41`).all(...values) as unknown as SavedWorkspace[];
    const entries = rows.slice(0, 40), last = entries.at(-1);
    return { entries, next: rows.length > 40 && last ? `${last.updatedAt}|${last.id}` : null };
  }
  private row(id: string, actor: Actor, admin: boolean, content = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AdminError(404, '工作区不存在。');
    const row = this.db.prepare(`SELECT ${columns}${content ? ",document" : ""} FROM workspaces WHERE id=?`).get(id) as unknown as (SavedWorkspace & { document?: string }) | undefined;
    if (!row || (!admin && row.owner !== actor.id)) throw new AdminError(404, '工作区不存在或无权访问。');
    return row;
  }
  read(id: string, actor: Actor, admin = false) {
    const { document, ...metadata } = this.row(id, actor, admin, true);
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
    return this.row(id, actor, false);
  }
  update(id: string, revision: string | undefined, value: unknown, actor: Actor, admin = false) {
    const row = this.row(id, actor, admin); this.match(row, revision);
    const input = this.input(value), now = new Date().toISOString();
    const changed = this.db.prepare('UPDATE workspaces SET name=?,updated_at=?,updated_by=?,revision=revision+1,bytes=?,tracks=?,marks=?,document=? WHERE id=? AND revision=?').run(input.name, now, actor.id, input.bytes, input.document.tracks.length, input.document.marks.length, input.json, id, row.revision);
    if (!changed.changes) throw new AdminError(409, '工作区已更新，请载入服务器版本或另存为副本。');
    return this.row(id, actor, admin);
  }
  remove(id: string, revision: string | undefined, actor: Actor, admin = false) {
    const row = this.row(id, actor, admin); this.match(row, revision);
    const changed = this.db.prepare('DELETE FROM workspaces WHERE id=? AND revision=?').run(id, row.revision);
    if (!changed.changes) throw new AdminError(409, '工作区已改变，请重新载入后再删除。');
    return { ok: true };
  }
  private match(row: SavedWorkspace, revision?: string) {
    if (!revision) throw new AdminError(428, '此操作需要工作区版本。');
    if (revision !== `"${row.revision}"`) throw new AdminError(409, '工作区已更新，请载入服务器版本或另存为副本。');
  }
  close() { this.db.close(); }
}
