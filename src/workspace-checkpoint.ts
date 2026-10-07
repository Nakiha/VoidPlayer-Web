import { parseWorkspace } from './workspace-file.ts';
import type { WorkspaceFile } from './workspace-file.ts';
import { LocalDatabase } from './local-database.ts';
export type WorkspaceCheckpoint = { id: string; actor: string; updatedAt: number; document: WorkspaceFile };
export type CheckpointSummary = Pick<WorkspaceCheckpoint, 'id' | 'updatedAt'> & { name: string; tracks: number; marks: number };
/** New tabs can inherit sessionStorage from their opener; only an actual
 * reload/back-forward navigation can reuse the previous tab's identity. */
export function checkpointTabId(previous: string, navigationType: string, fresh: string) {
  return ['reload', 'back_forward'].includes(navigationType) && /^[a-f0-9-]{36}$/i.test(previous) ? previous : fresh;
}
export const CHECKPOINT_LIMITS = { count: 100, bytes: 64 * 1024 * 1024 };
export type CheckpointUsage = { count: number; bytes: number; limits: { count: number; bytes: number } };
export class CheckpointCapacityError extends Error {
  constructor() { super('Local checkpoint capacity reached.'); this.name = 'CheckpointCapacityError'; }
}
type StoredSummary = CheckpointSummary & { actor: string; bytes: number };
function summarize(record: WorkspaceCheckpoint): StoredSummary {
  const doc = record.document;
  return { id: record.id, actor: record.actor, updatedAt: record.updatedAt,
    name: doc?.name ?? doc?.media?.[0]?.name ?? '', tracks: doc?.tracks?.length ?? 0, marks: doc?.marks?.length ?? 0,
    bytes: new TextEncoder().encode(JSON.stringify(record)).byteLength };
}
const DB_NAME = 'voidplayer-workspace-checkpoints';
/** Checkpoints are user work, never part of derived-cache cleanup. Per-tab
 * records prevent competing tabs from overwriting each other's workspace. */
export class WorkspaceCheckpoints {
  private limits: { count: number; bytes: number };
  private database = new LocalDatabase(DB_NAME, 2, (db, tx) => {
    if (!db.objectStoreNames.contains('checkpoints')) {
      const store = db.createObjectStore('checkpoints', { keyPath: 'id' });
      store.createIndex('actor-time', ['actor', 'updatedAt']);
    }
    const summaries = db.createObjectStore('summaries', { keyPath: 'id' });
    summaries.createIndex('actor', 'actor'); summaries.createIndex('actor-time', ['actor', 'updatedAt']);
    // Migration preserves every old record, including histories already over budget.
    const request = tx.objectStore('checkpoints').openCursor();
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      summaries.put(summarize(cursor.value)); cursor.continue();
    };
  }, '工作区恢复存储被阻塞。');
  constructor(limits = CHECKPOINT_LIMITS) {
    if (!Number.isSafeInteger(limits.count) || limits.count < 1 || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1) throw new Error('Invalid checkpoint limits.');
    this.limits = { ...limits };
  }
  async usage(actor: string): Promise<CheckpointUsage> {
    const db = await this.database.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('summaries').objectStore('summaries').index('actor').getAll(actor);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve({ count: request.result.length,
        bytes: request.result.reduce((sum: number, row: StoredSummary) => sum + row.bytes, 0), limits: { ...this.limits } });
    });
  }
  async read(actor: string, id: string): Promise<WorkspaceCheckpoint | undefined> {
    const db = await this.database.open();
    return new Promise<WorkspaceCheckpoint | undefined>((resolve, reject) => {
      const store = db.transaction('checkpoints').objectStore('checkpoints');
      const request = store.get(id);
      const validated = (record: WorkspaceCheckpoint | undefined) => {
        if (record?.actor !== actor) return undefined;
        try { return { ...record, document: parseWorkspace(record.document) }; } catch { return undefined; }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const preferred = validated(request.result); if (preferred) { resolve(preferred); return; }
        // Read one snapshot at a time; never clone all workspaces at startup.
        const cursor = store.index('actor-time').openCursor(IDBKeyRange.bound([actor, 0], [actor, Number.MAX_SAFE_INTEGER]), 'prev');
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const c = cursor.result; if (!c) { resolve(undefined); return; }
          const record = validated(c.value); if (record) resolve(record); else c.continue();
        };
      };
    });
  }

  async save(record: WorkspaceCheckpoint): Promise<void> {
    const summary = summarize(record), db = await this.database.open();
    await new Promise<void>((resolve, reject) => {
      // Both stores share one transaction: concurrent tabs cannot race past the budget.
      const tx = db.transaction(['checkpoints', 'summaries'], 'readwrite');
      const summaries = tx.objectStore('summaries');
      let failure: Error | undefined;
      const previous = summaries.get(record.id), all = summaries.index('actor').getAll(record.actor);
      let ready = 0;
      const apply = () => {
        if (++ready !== 2) return;
        const old = previous.result as StoredSummary | undefined, rows = all.result as StoredSummary[];
        if (old && old.actor !== record.actor) { failure = new Error('Checkpoint belongs to another actor.'); tx.abort(); return; }
        const count = rows.length + (old ? 0 : 1), oldBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
        const bytes = oldBytes - (old?.bytes ?? 0) + summary.bytes;
        // Legacy over-budget histories can shrink or update without growing.
        if ((count > this.limits.count && count > rows.length) || (bytes > this.limits.bytes && bytes > oldBytes)) {
          failure = new CheckpointCapacityError(); tx.abort(); return;
        }
        tx.objectStore('checkpoints').put(record); summaries.put(summary);
      };
      previous.onsuccess = apply; all.onsuccess = apply;
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('本机工作区检查点保存失败。'));
    });
  }
  async list(actor: string, before?: { updatedAt: number; id: string }, limit = 20): Promise<{ entries: CheckpointSummary[]; more: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid checkpoint page size.');
    const db = await this.database.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('summaries').objectStore('summaries').index('actor-time')
        .openCursor(IDBKeyRange.bound([actor, 0], [actor, before?.updatedAt ?? Number.MAX_SAFE_INTEGER]), 'prev');
      const entries: CheckpointSummary[] = [];
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve({ entries, more: false }); return; }
        const record = cursor.value as StoredSummary;
        if (before && record.updatedAt === before.updatedAt && record.id >= before.id) { cursor.continue(); return; }
        if (entries.length >= limit) { resolve({ entries, more: true }); return; }
        const { id, updatedAt, name, tracks, marks } = record;
        entries.push({ id, updatedAt, name, tracks, marks });
        cursor.continue();
      };
    });
  }
  async exact(actor: string, id: string): Promise<WorkspaceCheckpoint | undefined> {
    const db = await this.database.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('checkpoints').objectStore('checkpoints').get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try { const record = request.result as WorkspaceCheckpoint | undefined; resolve(record?.actor === actor ? { ...record, document: parseWorkspace(record.document) } : undefined); }
        catch (error) { reject(error); }
      };
    });
  }
  async remove(actor: string, id: string, updatedAt: number): Promise<boolean> {
    const db = await this.database.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['checkpoints', 'summaries'], 'readwrite'), store = tx.objectStore('checkpoints');
      let removed = false;
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as WorkspaceCheckpoint | undefined;
        if (record?.actor === actor && record.updatedAt === updatedAt) { store.delete(id); tx.objectStore('summaries').delete(id); removed = true; }
      };
      tx.oncomplete = () => resolve(removed); tx.onabort = () => reject(tx.error);
    });
  }
  close() { this.database.close(); }
}
