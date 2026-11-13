import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openIndexDatabase } from './sqlite.ts';
import type { IndexDatabase } from './sqlite.ts';
import type { Actor } from './identity.ts';
import { AdminError } from './admin-error.ts';

export class UserStore {
  private db: IndexDatabase;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = this.db = openIndexDatabase(file);
    try {
      if (file !== ':memory:') chmodSync(file, 0o600);
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw new Error('用户数据库来自更新的程序。');
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL DEFAULT 'named');
        PRAGMA user_version=1;`);
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
  close() { this.db.close(); }
}
