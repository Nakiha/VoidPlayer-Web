import { sourceKey } from './ui/source-catalog.ts';

/** Persistent local-file access via File System Access handles.
 *
 * `<input type=file>` Files die with the page and never expose a path, so a
 * history row can only keep metadata. A stored FileSystemFileHandle survives
 * reloads in IndexedDB: reopening is silent when the grant persisted, or one
 * permission click inside the row's gesture otherwise. Browsers without the
 * API keep the file-picker fallback; the real path stays unobtainable by
 * design in every API, so history rows never display or copy paths.
 */
export type HandleProblem = 'unavailable' | 'denied' | 'stale';
export class FileHandleError extends Error {
  readonly kind: HandleProblem;
  constructor(kind: HandleProblem, message: string) { super(message); this.kind = kind; }
}
/** Minimal File System Access surface (kept local: this repo's DOM lib has no
 * FS types). Real handles satisfy it structurally and keep working after an
 * IndexedDB structured-clone round trip. */
export type FsPermission = { mode: 'read' | 'readwrite' };
export interface FsFileHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission?(descriptor: FsPermission): Promise<PermissionState>;
  requestPermission?(descriptor: FsPermission): Promise<PermissionState>;
}
type FsPickerWindow = { showOpenFilePicker?: (options?: object) => Promise<FsFileHandle[]> };
type FsDropItem = { getAsFileSystemHandle?: () => Promise<{ kind: string } | null> };
export type HandleMeta = { name: string; size: number; lastModified: number };
export type HandleRecord = HandleMeta & { key: string; handle: FsFileHandle; savedAt: number };
export type HandleStore = {
  get(key: string): Promise<HandleRecord | undefined>;
  put(record: HandleRecord): Promise<void>;
  remove(key: string): Promise<void>;
  trim(limit?: number): Promise<void>;
};
export const HANDLE_DB = 'voidplayer.file-handles.v1';
const noStore = (): HandleStore => { throw new FileHandleError('unavailable', '当前环境不支持本地文件句柄存储。'); };

export const supportsFileHandles = () =>
  typeof window !== 'undefined'
  && typeof (window as unknown as FsPickerWindow).showOpenFilePicker === 'function'
  && globalThis.isSecureContext !== false;

export function indexedDBHandleStore(): HandleStore {
  if (typeof indexedDB === 'undefined') return noStore();
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('文件句柄存储被其他页面阻塞。'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  const run = <T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    database.then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction('handles', mode);
      tx.onabort = () => reject(tx.error ?? new Error('文件句柄事务中断。'));
      const request = task(tx.objectStore('handles'));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    }));
  return {
    get: key => run('readonly', store => store.get(key)).catch(() => undefined),
    put: record => run('readwrite', store => store.put(record)).then(() => {}),
    remove: key => run('readwrite', store => store.delete(key)).then(() => {}),
    trim: async (limit = 300) => {
      const db = await database;
      const keys = await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction('handles').objectStore('handles').getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      }).catch(() => [] as string[]);
      if (keys.length <= limit) return;
      const all = await new Promise<HandleRecord[]>((resolve, reject) => {
        const request = db.transaction('handles').objectStore('handles').getAll();
        request.onsuccess = () => resolve(request.result as HandleRecord[]);
        request.onerror = () => reject(request.error);
      }).catch(() => [] as HandleRecord[]);
      const drop = all.sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - limit).map(r => r.key);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('文件句柄事务中断。'));
        for (const key of drop) tx.objectStore('handles').delete(key);
      }).catch(() => {});
    },
  };
}

const fingerprintMatches = (file: HandleMeta, record: HandleRecord) =>
  file.name === record.name && file.size === record.size && file.lastModified === record.lastModified;

/** Reopen a stored handle inside a user gesture. Throws FileHandleError:
 * 'unavailable' (no record / dead API), 'denied' (grant refused), 'stale'
 * (file moved, replaced, or handle invalid — the record is deleted). */
export async function restoreHandleFile(key: string, store: HandleStore = indexedDBHandleStore()): Promise<File> {
  const record = await store.get(key).catch(() => undefined);
  if (!record?.handle) throw new FileHandleError('unavailable', '没有可恢复的本地文件句柄。');
  const handle = record.handle;
  try {
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission({ mode: 'read' });
      if (state !== 'granted') {
        const next = typeof handle.requestPermission === 'function'
          ? await handle.requestPermission({ mode: 'read' })
          : 'denied';
        if (next !== 'granted') throw new FileHandleError('denied', `已拒绝访问本地文件 ${record.name}。`);
      }
    }
    const file = await handle.getFile();
    if (!fingerprintMatches(file, record)) {
      await store.remove(key).catch(() => {});
      throw new FileHandleError('stale', `本地文件 ${record.name} 已变化，请重新选择。`);
    }
    return file;
  } catch (error) {
    if (error instanceof FileHandleError) throw error;
    const name = error instanceof Error ? error.name : '';
    await store.remove(key).catch(() => {});
    if (name === 'NotFoundError' || name === 'InvalidStateError') throw new FileHandleError('stale', `本地文件 ${record.name} 已移动或删除，请重新选择。`);
    if (name === 'AbortError' || name === 'SecurityError') throw new FileHandleError('denied', `已拒绝访问本地文件 ${record.name}。`);
    throw new FileHandleError('unavailable', `无法恢复本地文件 ${record.name}，请重新选择。`);
  }
}

export async function saveFileHandle(key: string, handle: FsFileHandle, meta: HandleMeta, store: HandleStore = indexedDBHandleStore()): Promise<void> {
  await store.put({ key, handle, name: meta.name, size: meta.size, lastModified: meta.lastModified, savedAt: Date.now() });
  await store.trim().catch(() => {});
}

/** Whether a restorable handle is stored. Render-safe: never throws, false
 * when the API is unavailable, storage fails, or no record exists. */
export async function hasFileHandle(key: string, store: HandleStore = indexedDBHandleStore()): Promise<boolean> {
  if (!supportsFileHandles()) return false;
  try { return (await store.get(key))?.handle != null; } catch { return false; }
}

export const handleKey = (file: HandleMeta) => sourceKey(file);

export type PickedVideo = { file: File; handle: FsFileHandle };
const VIDEO_TYPES = [{ description: '视频', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.avi', '.flv'] } }];

/** System picker returning usable Files plus persistable handles.
 * Returns null when the user cancels; throws FileHandleError('unavailable')
 * where the API is missing. Must run inside a user gesture. */
export async function pickVideoFiles(multiple: boolean): Promise<PickedVideo[] | null> {
  if (!supportsFileHandles()) throw new FileHandleError('unavailable', '当前浏览器不支持系统文件选择器。');
  try {
    const picker = (window as unknown as FsPickerWindow).showOpenFilePicker!;
    const handles = await picker({ multiple, types: VIDEO_TYPES });
    const picked: PickedVideo[] = [];
    for (const handle of handles) picked.push({ file: await handle.getFile(), handle });
    return picked;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw new FileHandleError('unavailable', '系统文件选择器不可用。');
  }
}

/** Best-effort handle capture for drag-and-drop items. Reads must start in
 * the drop event; anything unresolvable is skipped without failing the drop. */
export async function dropFileHandles(items: Iterable<DataTransferItem>): Promise<(FsFileHandle | undefined)[]> {
  const list = [...items].filter(item => item.kind === 'file');
  return Promise.all(list.map(async item => {
    try {
      const access = (item as unknown as FsDropItem).getAsFileSystemHandle;
      const handle = typeof access === 'function' ? await access.call(item) : null;
      return handle != null && handle.kind === 'file' ? handle as unknown as FsFileHandle : undefined;
    } catch { return undefined; }
  }));
}
