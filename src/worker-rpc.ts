import { randomUUID } from './uuid.ts';
import { MediaOpenError } from './media-errors.ts';
import type { OpenStage } from './media-errors.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { contextLog } from './log.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest } from './media-index-types.ts';
import type { FfmpegCommands, FfmpegInitResult as InitResult, WorkerMessage, IndexBatch, IndexError, IndexEvent, IndexInputPayload, CommandsShape } from './worker-protocol.ts';

export class WorkerRpc<C extends CommandsShape<C> = FfmpegCommands> {
  onIndexWaiting?: (waiting: boolean) => void;
  onIndexProgress?: (data: { durationUs: number; scannedBytes: number; totalBytes: number; packets: number }) => void;
  private indexHandlers?: { batch?: (data: IndexBatch) => void; complete?: (data: InitResult) => void; error?: (data: IndexError) => void };
  private queuedIndexEvents: IndexEvent[] = [];
  private indexProgressHandler?: (data: { scannedBytes: number; totalBytes: number; packets: number }) => void;
  private queuedIndexProgress?: { scannedBytes: number; totalBytes: number; packets: number };
  private indexRequestId?: number;
  private indexReady = false;
  private indexBuildId?: string;
  private indexTerminal = false;
  private workerId=randomUUID();
  private requests:{id:number;type:string;pts?:unknown;index?:unknown}[]=[];
  private worker: Worker;
  private nextId = 1;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; refresh?: () => void }>();
  private onTerminate: () => void;
  constructor(worker: Worker, onTerminate: () => void = () => {}, onProgress?: MediaOpenProgress) {
    this.onTerminate = onTerminate;
    this.worker = worker;
    const onMessage = (data: WorkerMessage<C>) => {
      if ('type' in data) {
        if (data.type === 'ready') {
          const entry = this.pending.get(data.id);
          if (!entry) return;
          if (data.id === this.indexRequestId) this.indexReady = true;
          clearTimeout(entry.timer); this.pending.delete(data.id); entry.resolve(data.data);
          return;
        }
        if (data.type === 'index-complete' || data.type === 'index-error') {
          if (this.failure || data.id !== this.indexRequestId || this.indexTerminal) return;
          this.indexTerminal = true;
          this.queuedIndexProgress = undefined;
          if (this.indexHandlers) {
            if (data.type === 'index-complete') this.indexHandlers.complete?.(data.data);
            else this.indexHandlers.error?.(data.data);
          } else this.queuedIndexEvents.push(data);
          return;
        }
        if (data.type === 'index-batch') {
          if (this.failure || data.id !== this.indexRequestId || this.indexTerminal
            || (this.indexBuildId !== undefined && data.data.buildId !== this.indexBuildId)) return;
          if (this.indexHandlers) this.indexHandlers.batch?.(data.data);
          else this.queuedIndexEvents.push({ type: 'index-batch', data: data.data });
          return;
        }
        if (data.type === 'index-waiting') { if (!this.failure) this.onIndexWaiting?.(data.data === true); return; }
        if (data.type === 'index-progress') {
          if (!this.failure && (data.id === this.indexRequestId || this.pending.has(data.id)) && !this.indexTerminal) {
            // Real scan advances keep waiting extraction RPCs alive, too.
            for (const entry of this.pending.values()) entry.refresh?.();
            const rawProgress = data.data;
            if (typeof rawProgress.durationUs === 'number') this.onIndexProgress?.({
              durationUs: rawProgress.durationUs, scannedBytes: rawProgress.scannedBytes,
              totalBytes: rawProgress.totalBytes, packets: rawProgress.packets,
            });
            const progress = {
              scannedBytes: rawProgress.scannedBytes, totalBytes: rawProgress.totalBytes, packets: rawProgress.packets,
            };
            if (this.indexProgressHandler) this.indexProgressHandler(progress);
            else if (data.id === this.indexRequestId) this.queuedIndexProgress = progress;
          }
          return;
        }
        if (data.type === 'progress') {
          const entry = this.pending.get(data.id);
          if (!this.failure && entry && data.progress) { entry.refresh?.(); onProgress?.(data.progress); }
          return;
        }
        return;
      }
      const { id, ok } = data;
      const payload = data.ok ? data.data : undefined;
      const entry = this.pending.get(id);
      if (!entry) {
        // A transferable VideoFrame may arrive after cancellation.
        closeLateFrame(payload);
        return;
      }
      if (data.ok && data.diagnostics?.length) contextLog().info('media', '原生解码路径探测', { workerId: this.workerId, requestId: id, decisions: data.diagnostics });
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (ok) entry.resolve(payload);
      else {
        const failure = data.stage ? new MediaOpenError(data.stage, data.error ?? '解码器错误') : new Error(data.error ?? 'WASM 解码器错误');
        if (data.stack) failure.stack += `\nWorker: ${data.stack}`;
        contextLog().warn('media', '解码 worker 请求失败', {workerId:this.workerId,requestId:id,recentRequests:this.requests,error:failure});
        entry.reject(failure);
      }
    };
    const fail = (message: string) => this.terminate(new Error(`WASM 解码 worker 异常：${message}`));
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', (event: MessageEvent<WorkerMessage<C>>) => onMessage(event.data));
      worker.addEventListener('error', event => fail(event.message ?? 'unknown'));
    } else {
      const nodeWorker = worker as unknown as import('node:worker_threads').Worker;
      nodeWorker.on('message', onMessage);
      nodeWorker.on('error', error => fail(error instanceof Error ? error.message : String(error)));
      nodeWorker.on('exit', code => fail(`exit ${code}`));
    }
  }
  setIndexHandlers(handlers?: { batch?: (data: IndexBatch) => void; complete?: (data: InitResult) => void; error?: (data: IndexError) => void }) {
    this.indexHandlers = handlers;
    if (!handlers) return;
    const queued = this.queuedIndexEvents.splice(0);
    for (const event of queued) {
      if (event.type === 'index-batch') handlers.batch?.(event.data);
      else if (event.type === 'index-complete') handlers.complete?.(event.data);
      else handlers.error?.(event.data);
    }
  }
  setIndexProgressHandler(handler?: (data: { scannedBytes: number; totalBytes: number; packets: number }) => void) {
    this.indexProgressHandler = handler;
    if (handler && this.queuedIndexProgress) {
      const progress = this.queuedIndexProgress;
      this.queuedIndexProgress = undefined;
      handler(progress);
    }
  }
  sendIndexManifest(ctx: number, manifest: MediaIndexRecordManifest, trace: MediaIndexClientTrace) {
    this.indexBuildId = manifest.buildId;
    this.pushIndexInput({ action: 'manifest', ctx, manifest, trace });
  }
  sendIndexBatch(ctx: number, batch: MediaIndexRecordBatch, trace: MediaIndexClientTrace) {
    const records = batch.records.slice();
    this.pushIndexInput({ action: 'batch', ctx, batch: { ...batch, records }, trace }, [records.buffer]);
  }
  sendIndexComplete(ctx: number, manifest: MediaIndexRecordManifest, frames: number, trace: MediaIndexClientTrace) {
    this.pushIndexInput({ action: 'complete', ctx, manifest, frames, trace });
  }
  sendLegacyIndex(ctx: number, index: unknown, trace: MediaIndexClientTrace) {
    this.indexBuildId = '';
    this.pushIndexInput({ action: 'legacy', ctx, index, trace });
  }
  startLocalIndex(ctx: number) {
    // A reset/failed transport can race an acknowledgement already in flight.
    // The replacement local build must establish its own usable timeline.
    this.indexBuildId = '';
    this.pushIndexInput({ action: 'fallback', ctx });
  }
  reportIndexError(error: string, stage: OpenStage = 'resource') {
    if (this.failure || this.indexTerminal) return;
    this.indexTerminal = true;
    this.queuedIndexProgress = undefined;
    const data = { error, stage };
    if (this.indexHandlers) this.indexHandlers.error?.(data);
    else this.queuedIndexEvents.push({ type: 'index-error', data });
  }
  private pushIndexInput(input: IndexInputPayload, transfer: Transferable[] = []) {
    if (this.failure || this.indexTerminal || this.indexRequestId === undefined) return;
    try { this.worker.postMessage({ id: this.indexRequestId, type: 'index-input', ...input }, transfer); }
    catch (error) { this.reportIndexError(error instanceof Error ? error.message : String(error)); }
  }
  call<K extends keyof C & string>(type: K, payload: NoInfer<C[K]['request']>, transfer: Transferable[] = [], timeoutMs = 15000, idleTimeout = false): Promise<C[K]['response']> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    if (type === 'init') this.indexRequestId = id;
    this.requests.push({id,type,pts:'pts' in payload ? payload.pts : undefined,index:'index' in payload ? payload.index : undefined});if(this.requests.length>16)this.requests.shift();
    return new Promise<C[K]['response']>((resolve, reject) => {
      const expire = () => this.terminate(new Error(`WASM ${type} 超时（${timeoutMs} ms）`));
      const entry = { resolve: resolve as (v: unknown) => void, reject, timer: setTimeout(expire, timeoutMs),
        refresh: idleTimeout ? () => { clearTimeout(entry.timer); entry.timer = setTimeout(expire, timeoutMs); } : undefined };
      this.pending.set(id, entry);
      try { this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { this.terminate(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  terminate(error = new Error('WASM worker 已释放。'), reportIndexFailure = true) {
    if (this.failure) return;
    const notifyIndex = reportIndexFailure && this.indexReady && !this.indexTerminal;
    this.failure = error;
    if (notifyIndex) {
      this.indexTerminal = true;
      this.queuedIndexProgress = undefined;
      const indexError = { error: error.message, stage: 'resource' as const };
      if (this.indexHandlers) this.indexHandlers.error?.(indexError);
      else this.queuedIndexEvents.push({ type: 'index-error', data: indexError });
    }
    this.onTerminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.worker.terminate();
  }
}

function closeLateFrame(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || !('frame' in payload)) return;
  const frame = payload.frame;
  if (typeof frame === 'object' && frame !== null && 'close' in frame && typeof frame.close === 'function') frame.close();
}
