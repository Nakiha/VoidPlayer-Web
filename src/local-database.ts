/** Lazy, retryable IndexedDB connection. A blocked open may still succeed
 * later; close that orphan instead of retaining an unreachable connection. */
export class LocalDatabase {
  private pending?: Promise<IDBDatabase>;
  private connection?: IDBDatabase;
  private cancel?: () => void;
  private generation = 0;

  private name: string;
  private version: number;
  private upgrade: (db: IDBDatabase, tx: IDBTransaction) => void;
  private blockedMessage: string;
  constructor(name: string, version: number,
    upgrade: (db: IDBDatabase, tx: IDBTransaction) => void, blockedMessage: string) {
    this.name = name; this.version = version;
    this.upgrade = upgrade; this.blockedMessage = blockedMessage;
  }

  open(): Promise<IDBDatabase> {
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version);
      let failed = false;
      const fail = (error: unknown) => {
        failed = true;
        if (generation === this.generation) { this.pending = undefined; this.cancel = undefined; }
        reject(error);
      };
      this.cancel = () => fail(new DOMException('Database connection closed.', 'AbortError'));
      request.onupgradeneeded = () => this.upgrade(request.result, request.transaction!);
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error(this.blockedMessage));
      request.onsuccess = () => {
        const db = request.result;
        if (failed || generation !== this.generation) { db.close(); return; }
        this.connection = db;
        this.cancel = undefined;
        const invalidate = () => {
          if (this.connection === db) { this.connection = undefined; this.pending = undefined; }
        };
        db.onversionchange = () => { invalidate(); db.close(); };
        db.onclose = invalidate;
        resolve(db);
      };
    });
    this.pending = opening;
    // Synchronous open errors reject before `pending` is assigned.
    void opening.catch(() => { if (this.pending === opening) this.pending = undefined; });
    return opening;
  }

  close() {
    this.cancel?.(); this.cancel = undefined;
    this.generation++;
    this.connection?.close(); this.connection = undefined;
    this.pending = undefined;
  }
}
