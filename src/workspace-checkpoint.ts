import { parseWorkspace } from './workspace-file.ts';
import type { WorkspaceFile } from './workspace-file.ts';
export type WorkspaceCheckpoint = { id: string; actor: string; updatedAt: number; document: WorkspaceFile };
const DB_NAME = 'voidplayer-workspace-checkpoints';
/** Checkpoints are user work, never part of derived-cache cleanup. Per-tab
 * records prevent competing tabs from overwriting each other's workspace. */
export class WorkspaceCheckpoints {
  private database?: Promise<IDBDatabase>;
  private db() {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('checkpoints', { keyPath: 'id' }); store.createIndex('actor-time', ['actor', 'updatedAt']); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('工作区恢复存储被阻塞。'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }
  async read(actor: string, id: string): Promise<WorkspaceCheckpoint | undefined> {
    const db = await this.db();
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
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put(record);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('本机工作区检查点保存失败。'));
    });
  }
  close() { void this.database?.then(db => db.close()); }
}
