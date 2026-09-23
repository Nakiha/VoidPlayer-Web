// Regenerable JPEGs only. Annotation drafts and file handles use other DBs.
export interface StoredThumbnail {
  key: string; blob: Blob; width: number; height: number; sourcePtsUs: number; updatedAt: number;
}
export const LOCAL_THUMB_BYTES = 32 * 1024 * 1024;
export const LOCAL_THUMB_COUNT = 512;
const DB_NAME = 'voidplayer-thumbnails', STORE = 'thumbs', META = 'lru';
type Meta = { key: string; bytes: number; accessedAt: number };
let database: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const connection = request.result;
      const thumbs = connection.objectStoreNames.contains(STORE) ? request.transaction!.objectStore(STORE) : connection.createObjectStore(STORE, { keyPath: 'key' });
      const meta = connection.createObjectStore(META, { keyPath: 'key' });
      // Migrate old Blob and byte records one at a time, never getAll() JPEGs.
      const cursor = thumbs.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result; if (!c) return;
        const v = c.value;
        meta.put({ key: v.key, bytes: v.blob?.size ?? v.bytes?.byteLength ?? 0, accessedAt: v.updatedAt ?? 0 });
        c.continue();
      };
    };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => reject(new Error('缩略图存储被其他页面阻塞。'));
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => { connection.close(); database = null; };
      // Enforce the budget on first open, including legacy records.
      const tx = connection.transaction([STORE, META], 'readwrite'); trim(tx);
      tx.oncomplete = () => resolve(connection);
      tx.onabort = () => { connection.close(); database = null; reject(tx.error); };
    };
  });
}
export function thumbnailEvictions(records: Meta[], maxBytes = LOCAL_THUMB_BYTES, maxCount = LOCAL_THUMB_COUNT): string[] {
  let bytes = records.reduce((sum, record) => sum + record.bytes, 0), count = records.length;
  const removed: string[] = [];
  for (const record of records.sort((a, b) => a.accessedAt - b.accessedAt || a.key.localeCompare(b.key))) {
    if (bytes <= maxBytes && count <= maxCount) break;
    removed.push(record.key); bytes -= record.bytes; count--;
  }
  return removed;
}
function trim(tx: IDBTransaction) {
  const request = tx.objectStore(META).getAll();
  request.onsuccess = () => {
    for (const key of thumbnailEvictions(request.result)) {
      tx.objectStore(STORE).delete(key); tx.objectStore(META).delete(key);
    }
  };
}
async function transact<T>(work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction([STORE, META], 'readwrite'); let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('缩略图事务中断。'));
    work(tx, result => { value = result; });
  });
}
export async function getLocalThumbnail(key: string): Promise<StoredThumbnail | undefined> {
  try {
    return await transact<StoredThumbnail | undefined>((tx, result) => {
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => {
        const entry = request.result; if (!entry) return result(undefined);
        const blob = entry.blob instanceof Blob ? entry.blob : entry.bytes instanceof ArrayBuffer ? new Blob([entry.bytes], { type: 'image/jpeg' }) : undefined;
        if (!blob) return result(undefined);
        tx.objectStore(META).put({ key, bytes: blob.size, accessedAt: Date.now() });
        const { bytes: _, ...metadata } = entry; result({ ...metadata, blob });
      };
    });
  } catch { return undefined; }
}
export async function putLocalThumbnail(entry: StoredThumbnail): Promise<boolean> {
  try {
    if (entry.blob.size > LOCAL_THUMB_BYTES) return false;
    const { blob, ...metadata } = entry, bytes = await blob.arrayBuffer();
    await transact<void>(tx => {
      tx.objectStore(STORE).put({ ...metadata, bytes });
      tx.objectStore(META).put({ key: entry.key, bytes: bytes.byteLength, accessedAt: Date.now() }); trim(tx);
    });
    return true;
  } catch { return false; }
}
export async function deleteLocalThumbnail(key: string): Promise<void> {
  try { await transact<void>(tx => { tx.objectStore(STORE).delete(key); tx.objectStore(META).delete(key); }); } catch {}
}
export function closeThumbnailDatabase() { void database?.then(connection => connection.close()).catch(() => {}); database = null; }
