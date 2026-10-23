import { QUERY_CONCURRENCY_LIMIT } from '../shared/media/indexing/semantic-query.ts';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AdminError } from './admin-error.ts';
import { mediaIndexIdentityKey } from '../shared/media/indexing/media-index-identity.ts';
import type { MediaIndexIdentity } from '../shared/media/indexing/media-index-identity.ts';
import type { FrameIndexOperation, FrameIndexCallArgs, FrameIndexResult, FrameIndexResponse } from './frame-index-protocol.ts';

type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type BuildRequest = {
  id: string;
  version: string;
  size: number;
  filePath: string;
  epoch: number;
  identity: MediaIndexIdentity;
  buildId: string;
};
export interface FrameIndexBuildPolicy {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}
export interface FrameIndexBuildOptions {
  policy?: FrameIndexBuildPolicy;
  onUpdate?: BuildUpdateListener;
  onProgress?: ProgressListener;
}
const DEFAULT_BUILD_POLICY: FrameIndexBuildPolicy = { idleTimeoutMs: 120_000, absoluteTimeoutMs: 24 * 60 * 60 * 1000 };

export function frameIndexBuildPolicy(env: NodeJS.ProcessEnv = process.env): FrameIndexBuildPolicy {
  const read = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1000 || value > max) {
      throw new Error(`${name} must be an integer from 1000 to ${max} milliseconds.`);
    }
    return value;
  };
  const policy = {
    idleTimeoutMs: read('VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS', DEFAULT_BUILD_POLICY.idleTimeoutMs, 24 * 60 * 60 * 1000),
    absoluteTimeoutMs: read('VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS', DEFAULT_BUILD_POLICY.absoluteTimeoutMs, 7 * 24 * 60 * 60 * 1000),
  };
  if (policy.absoluteTimeoutMs <= policy.idleTimeoutMs) throw new Error('VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS must exceed the idle timeout.');
  return policy;
}
type IndexBuildProgress = { phase: 'scan'; packets: number; scannedBytes: number; totalBytes: number; bytesRead?: number };
type ProgressListener = (progress: IndexBuildProgress) => void;
type BuildUpdateListener = () => void;
type QueuedBuild = {
  key: string;
  request: BuildRequest;
  promise: Promise<any>;
  resolve(value: any): void;
  reject(error: Error): void;
  listeners: Set<ProgressListener>;
  updateListeners: Set<BuildUpdateListener>;
  buildId: string;
  policy: FrameIndexBuildPolicy;
  latestProgress?: IndexBuildProgress;
};

/** Cache I/O and bounded, identity-deduplicated media-index builds use separate
 * workers. Packet-budgeted WASM scans report progress without blocking warm lookups. */
export class FrameIndexJobs {
  private worker?: Worker;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private database: string;
  private coreDir: string;
  private createBuildWorker:(data:{database:string;coreDir:string})=>Worker;
  private uploads = 0;
  private builds = new Map<string, QueuedBuild>();
  private buildQueue: QueuedBuild[] = [];
  private buildWorkers = new Set<Worker>();
  private activeBuilds = 0;
  private readonly maxConcurrentBuilds = 1;
  private readonly maxQueuedBuilds = 8;
  private readonly maxUploads = 2;
  private readonly defaultBuildPolicy = frameIndexBuildPolicy();

  constructor(privateDatabase: string, coreDir: string, createBuildWorker: (data: {database:string;coreDir:string})=>Worker = data=>new Worker(new URL('./frame-index-build-worker.ts',import.meta.url),{workerData:data})) { this.database = privateDatabase; this.coreDir = coreDir; this.createBuildWorker=createBuildWorker; }

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
    worker.on('message', (result: FrameIndexResponse) => {
      if (this.worker !== worker) return;
      const entry = this.pending.get(result.rpcId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(result.rpcId);
      if (result.error) entry.reject(new AdminError(result.status ?? 500, result.error, result.code));
      else entry.resolve(result.value);
    });
    worker.on('error', fail);
    worker.on('messageerror', () => fail(new Error('索引数据库 Worker 消息无法反序列化。')));
    worker.on('exit', code => fail(new Error('索引数据库 Worker 已退出 (' + code + ')')));
    return worker;
  }

  async call<K extends FrameIndexOperation>(op: K, ...args: FrameIndexCallArgs<K>): Promise<FrameIndexResult<K>> {
    const [data = {}, transfer = [], timeoutMs = 60000] = args;
    if (this.closed) throw new AdminError(503, '索引服务已关闭。');
    if ((op === 'cached-indexes' || op === 'semantic-query') && this.pending.size >= QUERY_CONCURRENCY_LIMIT) {
      throw new AdminError(503, 'Cached media queries are busy; retry later.', 'media-query-busy');
    }
    const isQuery = op === 'semantic-query' || op === 'cached-indexes';
    const queryData = data as { cancellation?: SharedArrayBuffer };
    if (op === 'semantic-query') queryData.cancellation ??= new SharedArrayBuffer(4);
    let timedOut = false;
    const worker = this.databaseWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (isQuery) {
          // Keep capacity until the worker acknowledges completion/cancellation.
          timedOut = true;
          if (queryData.cancellation) Atomics.store(new Int32Array(queryData.cancellation), 0, 1);
          return;
        }
        this.pending.delete(id);
        reject(new AdminError(503, '索引数据库操作超时，请稍后重试。'));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => timedOut ? reject(new AdminError(503, '索引数据库操作超时，请稍后重试。')) : resolve(value as FrameIndexResult<K>), reject, timer });
      try { worker.postMessage({ rpcId: id, op, ...data }, transfer); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  buildIndex(request: Omit<BuildRequest, 'buildId'>, options: FrameIndexBuildOptions = {}): Promise<any> {
    const handle = this.startBuild(request, options);
    return handle.promise;
  }

  startBuild(request: Omit<BuildRequest, 'buildId'>, options: FrameIndexBuildOptions = {}) {
    if (this.closed) throw new AdminError(503, '索引服务已关闭。');
    const policy = { ...(options.policy ?? this.defaultBuildPolicy) };
    if (!Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs < 1000
      || !Number.isSafeInteger(policy.absoluteTimeoutMs) || policy.absoluteTimeoutMs <= policy.idleTimeoutMs) {
      throw new AdminError(400, '帧索引构建超时策略无效。');
    }
    const key = request.id + ':' + request.version + ':' + request.epoch + ':' + mediaIndexIdentityKey(request.identity);
    const joined = this.builds.get(key);
    if (joined) {
      if (options.onUpdate) { joined.updateListeners.add(options.onUpdate); try { options.onUpdate(); } catch {} }
      if (options.onProgress) {
        joined.listeners.add(options.onProgress);
        if (joined.latestProgress) {
          try { options.onProgress(joined.latestProgress); } catch {}
        }
      }
      return { buildId: joined.buildId, promise: joined.promise, unsubscribe: () => {
        if (options.onUpdate) joined.updateListeners.delete(options.onUpdate);
        if (options.onProgress) joined.listeners.delete(options.onProgress);
      } };
    }
    if (this.activeBuilds >= this.maxConcurrentBuilds && this.buildQueue.length >= this.maxQueuedBuilds) {
      throw new AdminError(503, '索引构建队列已满，请稍后重试。');
    }
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    const buildId = randomUUID();
    const job: QueuedBuild = { key, request: { ...request, buildId }, promise, resolve, reject,
      listeners: new Set(), updateListeners: new Set(), buildId, policy };
    if (options.onProgress) job.listeners.add(options.onProgress);
    if (options.onUpdate) job.updateListeners.add(options.onUpdate);
    this.builds.set(key, job);
    this.buildQueue.push(job);
    this.pumpBuilds();
    return { buildId, promise, unsubscribe: () => {
      if (options.onUpdate) job.updateListeners.delete(options.onUpdate);
      if (options.onProgress) job.listeners.delete(options.onProgress);
    } };
  }

  private notifyBuildUpdate(job: QueuedBuild) {
    for (const listener of job.updateListeners) { try { listener(); } catch {} }
  }

  private notifyBuildProgress(job: QueuedBuild, progress: IndexBuildProgress) {
    job.latestProgress = progress;
    for (const listener of job.listeners) {
      try { listener(progress); } catch {}
    }
  }

  private pumpBuilds() {
    while (!this.closed && this.activeBuilds < this.maxConcurrentBuilds && this.buildQueue.length) {
      const job = this.buildQueue.shift()!;
      this.activeBuilds++;
      void this.runBuild(job.request, job.policy, progress => { this.notifyBuildProgress(job, progress); this.notifyBuildUpdate(job); }, () => this.notifyBuildUpdate(job))
        .then(job.resolve, job.reject).finally(() => {
          this.activeBuilds--;
          if (this.builds.get(job.key) === job) this.builds.delete(job.key);
          this.notifyBuildUpdate(job);
          this.pumpBuilds();
        });
    }
  }

  private runBuild(request: BuildRequest, policy: FrameIndexBuildPolicy, onProgress: ProgressListener, onUpdate: () => void): Promise<any> {
    let worker: Worker;
    try {
      worker = this.createBuildWorker({database:this.database,coreDir:this.coreDir});
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    this.buildWorkers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      let absoluteTimer: ReturnType<typeof setTimeout>;
      let latestPackets = -1, latestScannedBytes = -1, latestBytesRead = -1;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(new AdminError(503, '媒体索引构建进度停滞。')), policy.idleTimeoutMs);
      };
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(absoluteTimer);
        this.buildWorkers.delete(worker);
        void worker.terminate();
        if (error) reject(error); else resolve(value);
      };
      resetIdleTimer();
      absoluteTimer = setTimeout(() => finish(new AdminError(503, '媒体索引构建超过绝对安全期限。')), policy.absoluteTimeoutMs);
      worker.on('message', (result: { type?: string; data?: unknown; value?: unknown; error?: string; status?: number;code?:string }) => {
        if (settled) return;
        if (result.type === 'progress') {
          const progress = result.data as IndexBuildProgress;
          if (progress.bytesRead !== undefined && (!Number.isSafeInteger(progress.bytesRead) || progress.bytesRead<0
            || progress.bytesRead>Math.min(Number.MAX_SAFE_INTEGER,request.size*4+32*1024*1024))) { finish(new AdminError(503,'JS 索引读取进度预算无效。'));return; }
          if (progress.packets > latestPackets || progress.scannedBytes > latestScannedBytes
            || progress.bytesRead !== undefined && progress.bytesRead>latestBytesRead) {
            latestPackets = progress.packets;
            latestScannedBytes = progress.scannedBytes;
            if(progress.bytesRead !== undefined)latestBytesRead=progress.bytesRead;
            resetIdleTimer();
          }
          try { onProgress(progress); } catch {}
          return;
        }
        if (result.type === 'manifest' || result.type === 'batch' || result.type === 'complete') { onUpdate(); return; }
        if (result.error) finish(new AdminError(result.status ?? 500, result.error,result.code));
        else {
          const value = result.value as { built?: boolean; profile?: Record<string, unknown> } | undefined;
          if (value?.built && value.profile) {
            console.info(JSON.stringify({
              event: 'frame-index-build-profile', mediaId: request.id, mediaVersion: request.version,
              buildId: request.buildId, identity: request.identity, ...value.profile,
            }));
          }
          finish(undefined, result.value);
        }
      });
      worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('messageerror', () => finish(new Error('媒体索引构建 Worker 消息无法反序列化。')));
      worker.once('exit', code => { if (!settled) finish(new Error('媒体索引构建 Worker 已退出 (' + code + ')')); });
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
