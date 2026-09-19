// Browser-local thumbnail Blob storage (IndexedDB). Server media and local
// files both land here for instant display; only server media additionally
// uploads. Blobs only, never base64. Object URLs stay ephemeral per page.

export interface StoredThumbnail {
  key: string;
  blob: Blob;
  width: number;
  height: number;
  sourcePtsUs: number;
  updatedAt: number;
}

const DB_NAME = 'voidplayer-thumbnails';
const STORE = 'thumbs';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onerror = () => reject(request.error ?? new Error('缩略图存储打开失败。'));
      request.onblocked = () => reject(new Error('缩略图存储被其他页面阻塞。'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    } catch (error) { reject(error); }
  });
}

let database: Promise<IDBDatabase> | null = null;
const db = () => (database ??= openDatabase());

function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    connection =>
      new Promise<T>((resolve, reject) => {
        try {
          const tx = connection.transaction(STORE, mode);
          tx.onabort = () => reject(tx.error ?? new Error('缩略图事务中断。'));
          const request = work(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('缩略图读写失败。'));
        } catch (error) { reject(error); }
      }),
    error => Promise.reject(error),
  );
}

export async function getLocalThumbnail(key: string): Promise<StoredThumbnail | undefined> {
  try {
    return await transact('readonly', store => store.get(key));
  } catch { return undefined; }
}

export async function putLocalThumbnail(entry: StoredThumbnail): Promise<boolean> {
  try {
    await transact('readwrite', store => store.put(entry));
    return true;
  } catch { return false; }
}

export async function deleteLocalThumbnail(key: string): Promise<void> {
  try { await transact('readwrite', store => store.delete(key)); } catch {}
}

/** Test hook: drop the cached connection after clearing. */
export function closeThumbnailDatabase() {
  void database?.then(connection => connection.close()).catch(() => {});
  database = null;
}
