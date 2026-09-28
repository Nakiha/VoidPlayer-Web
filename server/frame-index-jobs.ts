import { Worker } from 'node:worker_threads';
import { AdminError } from './admin-error.ts';
import { mediaIndexIdentityKey } from '../src/media-index-identity.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

type PendingRequest = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type BuildRequest = {
  id: string;
  version: string;
  size: number;
  filePath: string;
  epoch: number;
  identity: MediaIndexIdentity;
};
type QueuedBuild = {
  key: string;
  request: BuildRequest;
  resolve(value: any): void;
  reject(error: Error): void;
};

/** Cache I/O and bounded, identity-deduplicated FFmpeg builds use separate
 * workers. A long synchronous WASM scan therefore cannot block warm lookups. */
export class FrameIndexJobs {
  private worker?: Worker;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private database: string;
  private coreDir: string;
  private uploads = 0;
  private builds = new Map<string, Promise<any>>();
  private buildQueue: QueuedBuild[] = [];
  private buildWorkers = new Set<Worker>();
  private activeBuilds = 0;
  private readonly maxConcurrentBuilds = 1;
  private readonly maxQueuedBuilds = 8;
  private readonly maxUploads = 2;

  constructor(privateDatabase: string, coreDir: string) { this.database = privateDatabase; this.coreDir = coreDir; }

  acquireUpload(): () => void {
    if (this.closed || this.uploads >= this.maxUploads) throw new AdminError(503, '索引上传繁忙，请稍后重试。');
    this.uploads++;
    let released = false;
    return () => { if (!released) { released = true; this.uploads--; } };
  }

  private databaseWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.worker = new Worker(new URL('./frame-index-worker.ts', import.meta.url), {
      workerData: { database: this.database },
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
        this.pending.delete(id);
      }
      void worker.terminate();
    };
    worker.on('message', (result: { rpcId: number; value?: unknown; error?: string; status?: number }) => {
      if (this.worker !== worker) return;
      const entry = this.pending.get(result.rpcId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(result.rpcId);
      if (result.error) entry.reject(new AdminError(result.status ?? 500, result.error));
      else entry.resolve(result.value);
    });
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error('索引数据库 Worker 已退出 (' + code + ')')));
    return worker;
  }

  async call(op: string, data: Record<string, unknown> = {}, transfer: ArrayBuffer[] = [], timeoutMs = 60000): Promise<any> {
    if (this.closed) throw new AdminError(503, '索引服务已关闭。');
    const worker = this.databaseWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdminError(503, '索引数据库操作超时，请稍后重试。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ rpcId: id, op, ...data }, transfer); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  buildIndex(request: BuildRequest, timeoutMs = 300000): Promise<any> {
    if (this.closed) return Promise.reject(new AdminError(503, '索引服务已关闭。'));
    const key = request.id + ':' + request.version + ':' + request.epoch + ':' + mediaIndexIdentityKey(request.identity);
    const joined = this.builds.get(key);
    if (joined) return joined;
    if (this.activeBuilds >= this.maxConcurrentBuilds && this.buildQueue.length >= this.maxQueuedBuilds) {
      return Promise.reject(new AdminError(503, '索引构建队列已满，请稍后重试。'));
    }
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    this.builds.set(key, promise);
    this.buildQueue.push({ key, request, resolve, reject });
    this.pumpBuilds(timeoutMs);
    return promise;
  }

  private pumpBuilds(timeoutMs: number) {
    while (!this.closed && this.activeBuilds < this.maxConcurrentBuilds && this.buildQueue.length) {
      const job = this.buildQueue.shift()!;
      this.activeBuilds++;
      void this.runBuild(job.request, timeoutMs).then(job.resolve, job.reject).finally(() => {
        this.activeBuilds--;
        if (this.builds.get(job.key)) this.builds.delete(job.key);
        this.pumpBuilds(timeoutMs);
      });
    }
  }

  private runBuild(request: BuildRequest, timeoutMs: number): Promise<any> {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./frame-index-build-worker.ts', import.meta.url), {
        workerData: { database: this.database, coreDir: this.coreDir },
      });
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    this.buildWorkers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.buildWorkers.delete(worker);
        void worker.terminate();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new AdminError(503, 'FFmpeg 索引构建超时，请稍后重试。')), timeoutMs);
      worker.once('message', (result: { value?: unknown; error?: string; status?: number }) => {
        if (result.error) finish(new AdminError(result.status ?? 500, result.error));
        else finish(undefined, result.value);
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => { if (!settled) finish(new Error('FFmpeg 索引构建 Worker 已退出 (' + code + ')')); });
      try { worker.postMessage(request); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async close() {
    this.closed = true;
    for (const job of this.buildQueue.splice(0)) {
      this.builds.delete(job.key);
      job.reject(new AdminError(503, '索引服务已关闭。'));
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new AdminError(503, '索引服务已关闭。'));
    }
    this.pending.clear();
    const workers = [...this.buildWorkers];
    this.buildWorkers.clear();
    const databaseWorker = this.worker;
    this.worker = undefined;
    await Promise.allSettled([
      ...(databaseWorker ? [databaseWorker.terminate()] : []),
      ...workers.map(worker => worker.terminate()),
    ]);
  }
}
