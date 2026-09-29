import type { WasmFrameOutput } from './wasm-frame.ts';
import { validateDescription } from './frame-description.ts';
import type { MediaOpenProgress, MediaLoadStage } from './media-progress.ts';
import { loadAborted, onLoadAbort } from './media-abort.ts';
import { createRangeBridge } from './range-bridge.ts';
import { randomUUID } from './uuid.ts';
import { MediaOpenError } from './media-errors.ts';
import type { OpenStage } from './media-errors.ts';
import type { DecodedFrame, MediaSource, MediaMeta } from './media.ts';
import type { MediaInfo } from './model.ts';
import { MAX_FALLBACK_FILE_BYTES } from './model.ts';
import { contextLog } from './log.ts';
import { updateMediaInfo } from './media-state.ts';
import { ffmpegColorInfo } from './media-metadata.ts';
import { isHdrTransfer } from './presentation-color.ts';
import { resolveYuvColor } from './yuv-color.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest } from './media-index-types.ts';
import { FfmpegContainerSession, FfmpegMediaIndexSession } from './media-index-session.ts';
import type { FfmpegIndexRecordSink } from './media-index-session.ts';

// FFmpeg-WASM fallback media source for tracks mediabunny/WebCodecs cannot
// demux or decode (FFV1, MPEG-2 TS, H.266/VVC, H.264 4:2:2, ...). The
// self-built core runs inside a Web Worker (`src/ffmpeg-worker.ts`): decode is
// synchronous CPU work and must stay off the UI thread. Pixels come back as
// transferred buffers; the frame index travels once at open.


export interface WasmDecodedFrame extends DecodedFrame {
  pixels: Uint8ClampedArray;
}

// Greatest index whose time is at most ptsUs (0 when none), and the first
// index strictly after ptsUs (-1 when none). Pure binary-search helpers for
// the session's frameAt/framesAfter contract.
export function floorIndex(timesUs: number[], ptsUs: number): number {
  let lo = 0, hi = timesUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] <= ptsUs) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function nextIndex(timesUs: number[], ptsUs: number): number {
  let lo = 0, hi = timesUs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesUs[mid] > ptsUs) hi = mid; else lo = mid + 1;
  }
  return lo < timesUs.length ? lo : -1;
}

export const WASM_CORE_GLUE_PATH = 'vendor/voidplayer-core/voidplayer-core.js';
export const WASM_CORE_GLUE_PATH_MT = 'vendor/voidplayer-core/voidplayer-core-mt.js';
export const WASM_CORE_WASM_PATH = 'vendor/voidplayer-core/voidplayer-core.wasm';

export interface FallbackDeps {
  /** Keep native packet frames intact for the reference Worker readback gate. */
  rawNative?: boolean;
  /** Local same-frame color diagnostics only; normal playback releases native samples after copying. */
  preserveNativeSample?: boolean;
  /** Opt-in external-texture experiment: keep native GPU resources, no plane readback. */
  nativeColorMode?: 'browser';
  onProgress?: MediaOpenProgress;
  signal?: AbortSignal;
  /** Glue module URL (browser default: served from public/; tests: file URL). */
  glueURL?: string;
  /** Wasm binary bytes (tests pass them; the browser lets the glue fetch it). */
  wasmBinary?: Uint8Array;
  workerFactory?: () => Worker;
}

interface InitResult {
  ctx: number;
  firstPts?: number;
  firstFrame?: WasmFrameOutput;
  path: string;
  ticks: number[];
  durations: number[];
  tbNum: number;
  tbDen: number;
  width: number;
  height: number;
  codec: string;
  indexMs?: number;
  indexSource?: 'server' | 'client';
  localIndexBuildCalls?: number;
  seekAnchorCount?: number;
  ioMode?: 'blob' | 'memfs' | 'http-range';
  colorPrimaries?: number;
  colorTransfer?: number;
  colorSpace?: number;
  colorRange?: number;
  pixelFormat?: string | null;
  indexIdentity?: MediaIndexIdentity;
  indexTrace?: MediaIndexClientTrace;
  indexPending?: boolean;
}

// Player-side thread budget: fallback decoders share the host's cores, each
// live fallback track getting an equal share of (cores − 2), capped by the
// pthread pool the mt core was built with.
let liveFallbacks = 0;
function threadBudget(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, Math.floor((cores - 2) / Math.max(1, liveFallbacks))));
}

/** Shared budget for packet-fed fallback workers and file-fed fallback workers. */
export function reserveFallbackThreads() {
  liveFallbacks++;
  let released = false;
  return { threads: threadBudget(), release() { if (!released) { released = true; liveFallbacks--; } } };
}

async function createWorker(): Promise<Worker> {
  if (typeof Worker !== 'undefined') return new Worker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module' });
  // Node tests: worker_threads with the same message surface.
  const { Worker: NodeWorker } = await import('node:worker_threads');
  return new NodeWorker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module' } as object) as unknown as Worker;
}

export class WorkerRpc {
  onIndexWaiting?: (waiting: boolean) => void;
  onIndexProgress?: (data: { durationUs: number; scannedBytes: number; totalBytes: number; packets: number }) => void;
  private indexHandlers?: { batch?: (data: { ctx: number; ticks: number[]; durations: number[]; stableCoverageUs: number; seekAnchorCount: number; buildId: string; indexIdentity?: MediaIndexIdentity; indexTrace?: MediaIndexClientTrace }) => void; complete?: (data: InitResult) => void; error?: (data: { error: string; stage?: OpenStage }) => void };
  private queuedIndexEvents: { type: 'index-batch' | 'index-complete' | 'index-error'; data: any }[] = [];
  private indexProgressHandler?: (data: { scannedBytes: number; totalBytes: number; packets: number }) => void;
  private queuedIndexProgress?: { scannedBytes: number; totalBytes: number; packets: number };
  private indexRequestId?: number;
  private indexReady = false;
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
    const onMessage = (data: { id: number; ok: boolean; data: any; error?: string; stack?: string; stage?: OpenStage; type?: string; progress?: MediaLoadStage; diagnostics?: Record<string, unknown>[] }) => {
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
        } else this.queuedIndexEvents.push({ type: data.type, data: data.data });
        return;
      }
      if (data.type === 'index-batch') {
        if (this.failure || data.id !== this.indexRequestId || this.indexTerminal) return;
        if (this.indexHandlers) this.indexHandlers.batch?.(data.data);
        else this.queuedIndexEvents.push({ type: 'index-batch', data: data.data });
        return;
      }
      if (data.type === 'index-waiting') { if (!this.failure) this.onIndexWaiting?.(data.data === true); return; }
      if (data.type === 'index-progress') {
        if (!this.failure && (data.id === this.indexRequestId || this.pending.has(data.id)) && !this.indexTerminal) {
          // Real scan advances keep waiting extraction RPCs alive, too.
          for (const entry of this.pending.values()) entry.refresh?.();
          const rawProgress = data.data as { durationUs?: number; scannedBytes: number; totalBytes: number; packets: number };
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
      const { id, ok, data: payload, error } = data;
      const entry = this.pending.get(id);
      if (!entry) {
        // A transferable VideoFrame may arrive after cancellation.
        (payload as { frame?: VideoFrame } | null)?.frame?.close();
        return;
      }
      if (data.diagnostics?.length) contextLog().info('media', '原生解码路径探测', { workerId: this.workerId, requestId: id, decisions: data.diagnostics });
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (ok) entry.resolve(payload);
      else {
        const failure = data.stage ? new MediaOpenError(data.stage, error ?? '解码器错误') : new Error(error ?? 'WASM 解码器错误');
        if (data.stack) failure.stack += `\nWorker: ${data.stack}`;
        contextLog().warn('media', '解码 worker 请求失败', {workerId:this.workerId,requestId:id,recentRequests:this.requests,error:failure});
        entry.reject(failure);
      }
    };
    const fail = (message: string) => this.terminate(new Error(`WASM 解码 worker 异常：${message}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyWorker = worker as any;
    if (typeof anyWorker.addEventListener === 'function') {
      anyWorker.addEventListener('message', (e: { data: unknown }) => onMessage(e.data as never));
      anyWorker.addEventListener('error', (e: { message?: string }) => fail(e.message ?? 'unknown'));
    } else {
      anyWorker.on('message', onMessage);
      anyWorker.on('error', (e: unknown) => fail(e instanceof Error ? e.message : String(e)));
      anyWorker.on('exit', (code: number) => fail(`exit ${code}`));
    }
  }
  setIndexHandlers(handlers?: { batch?: (data: { ctx: number; ticks: number[]; durations: number[]; stableCoverageUs: number; seekAnchorCount: number; buildId: string; indexIdentity?: MediaIndexIdentity; indexTrace?: MediaIndexClientTrace }) => void; complete?: (data: InitResult) => void; error?: (data: { error: string; stage?: OpenStage }) => void }) {
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
    this.pushIndexInput('manifest', ctx, { manifest, trace });
  }
  sendIndexBatch(ctx: number, batch: MediaIndexRecordBatch, trace: MediaIndexClientTrace) {
    const records = batch.records.slice();
    this.pushIndexInput('batch', ctx, { batch: { ...batch, records }, trace }, [records.buffer]);
  }
  sendIndexComplete(ctx: number, manifest: MediaIndexRecordManifest, frames: number, trace: MediaIndexClientTrace) {
    this.pushIndexInput('complete', ctx, { manifest, frames, trace });
  }
  sendLegacyIndex(ctx: number, index: unknown, trace: MediaIndexClientTrace) {
    this.pushIndexInput('legacy', ctx, { index, trace });
  }
  startLocalIndex(ctx: number) { this.pushIndexInput('fallback', ctx); }
  reportIndexError(error: string, stage: OpenStage = 'resource') {
    if (this.failure || this.indexTerminal) return;
    this.indexTerminal = true;
    this.queuedIndexProgress = undefined;
    const data = { error, stage };
    if (this.indexHandlers) this.indexHandlers.error?.(data);
    else this.queuedIndexEvents.push({ type: 'index-error', data });
  }
  private pushIndexInput(action: string, ctx: number, data: Record<string, unknown> = {}, transfer: Transferable[] = []) {
    if (this.failure || this.indexTerminal || this.indexRequestId === undefined) return;
    try { this.worker.postMessage({ id: this.indexRequestId, type: 'index-input', action, ctx, ...data }, transfer); }
    catch (error) { this.reportIndexError(error instanceof Error ? error.message : String(error)); }
  }
  call<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[] = [], timeoutMs = 15000, idleTimeout = false): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    if (type === 'init') this.indexRequestId = id;
    this.requests.push({id,type,pts:payload.pts,index:payload.index});if(this.requests.length>16)this.requests.shift();
    return new Promise<T>((resolve, reject) => {
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

type FallbackInput = File | (MediaMeta & { url: string });

export async function openFFmpegMediaFromUrl(url: string, meta: MediaMeta, deps: FallbackDeps = {}): Promise<MediaSource> {
  const { openSoftwareMedia } = await import('./software-media.ts');
  return openSoftwareMedia({ url, size: meta.size }, meta, deps);
}

function ffmpegIndexMediaUrl(url: string): string | undefined {
  try {
    const source = new URL(url, globalThis.location?.href);
    if (!/^\/api\/media\/[0-9a-f]{24}$/.test(source.pathname) || !source.searchParams.has('v')) return undefined;
    source.searchParams.set('kind', 'ffmpeg');
    return source.href;
  } catch { return undefined; }
}

/** Raw container adapter; higher layers select it through the shared router. */
export function openFFmpegContainerFromUrl(url: string, meta: MediaMeta, deps: FallbackDeps = {}): Promise<MediaSource> {
  return openFallbackInput({ ...meta, url }, deps);
}

export function openFFmpegMedia(file: File, deps: FallbackDeps = {}): Promise<MediaSource> {
  return openFallbackInput(file, deps);
}

async function openFallbackInput(file: FallbackInput, deps: FallbackDeps): Promise<MediaSource> {
  loadAborted(deps.signal);
  const openStart = performance.now();
  liveFallbacks++;
  try {
    return await openFFmpegMediaInner(file, deps, openStart);
  } catch (error) {
    liveFallbacks--;
    throw error;
  }
}

async function openFFmpegMediaInner(file: FallbackInput, deps: FallbackDeps, openStart: number): Promise<MediaSource> {
  // The Blob crosses into the worker by reference; there the custom AVIO
  // reads it in chunks via FileReaderSync, so the file never enters WASM
  // memory at all. Environments without FileReaderSync (Node tests) buffer
  // the whole file in the worker and enforce the byte cap there.
  if (!('url' in file) && file.size > MAX_FALLBACK_FILE_BYTES && typeof File === 'undefined') {
    throw new Error(`文件超过 WASM 回退解码的 ${MAX_FALLBACK_FILE_BYTES / 1024 / 1024} MiB 内存上限。`);
  }
  // In a cross-origin-isolated page, SharedArrayBuffer unlocks the
  // multi-threaded core (pthreads); try it first and fall back to the
  // single-threaded core when it is not vendored, cannot start, or hangs
  // (nested pthread workers wedging in some WebKit builds) — a wedged worker
  // is terminated and replaced.
  const candidates: string[] = [];
  const indexUrl = 'url' in file ? ffmpegIndexMediaUrl(file.url) : undefined;
  if (deps.glueURL) candidates.push(deps.glueURL);
  else {
    if (globalThis.crossOriginIsolated) candidates.push(new URL(`/${WASM_CORE_GLUE_PATH_MT}`, location.origin).href);
    candidates.push(new URL(`/${WASM_CORE_GLUE_PATH}`, location.origin).href);
  }
  const scoped = contextLog();
  const readMs = Math.round(performance.now() - openStart);
  const threads = threadBudget();
  let coreVariant: 'single-thread' | 'multi-thread' = 'single-thread';
  let init: InitResult | null = null;
  let rpc: WorkerRpc | null = null;
  let lastError: unknown = null;
  for (const glueURL of candidates) {
    loadAborted(deps.signal);
    rpc?.terminate();
    const worker = deps.workerFactory?.() ?? await createWorker();
    let bridge: ReturnType<typeof createRangeBridge> | undefined;
    try {
      if ('url' in file) bridge = createRangeBridge(worker, file.url, file.size);
    } catch (error) { worker.terminate(); throw error; }
    rpc = new WorkerRpc(worker, () => bridge?.close(), deps.onProgress);
    const activeRpc = rpc;
    const detachAbort = onLoadAbort(deps.signal, () => activeRpc.terminate(deps.signal!.reason));
    try {
      const payload: Record<string, unknown> = { glueURL, name: file.name, threads, mediaSize: file.size, externalIndexSession: !!indexUrl,
        ...('url' in file ? { range: { shared: bridge!.shared, size: file.size } } : { blob: file }) };
      const transfer: Transferable[] = [];
      if (deps.wasmBinary) {
        payload.wasmBinary = new Uint8Array(deps.wasmBinary).buffer;
        transfer.push(payload.wasmBinary as ArrayBuffer);
      }
      // Includes fetching/compiling the core and scanning the file's index.
      // Five seconds is not a viable cold-start budget over a LAN.
      deps.onProgress?.('decoder');
      // A legacy core may still build its local index during init. Keep a wide
      // safety cap here; supported cores return after first-frame priming and
      // stream their index through the main-thread session below.
      init = await rpc.call<InitResult>('init', payload, transfer, 24 * 60 * 60 * 1000);
      coreVariant = glueURL.includes('core-mt.') ? 'multi-thread' : 'single-thread';
      scoped.info('media', 'WASM core 已就绪', {
        coreVariant, crossOriginIsolated: !!globalThis.crossOriginIsolated,
        ioMode: init.ioMode, indexSource: init.indexSource, localIndexBuildCalls: init.localIndexBuildCalls ?? 0, readMs, initIndexMs: init.indexMs, threads,
      });
      scoped.info('media', '媒体管线追踪', {
        phase: 'first-frame-ready', name: file.name, container: 'ffmpeg', demuxBackend: 'ffmpeg-wasm',
        indexBackend: init.indexSource ?? 'client', indexIdentity: init.indexIdentity,
        indexBuildId: init.indexTrace?.indexBuildId, serverIndexRequests: init.indexTrace?.serverIndexRequests ?? 0,
        firstIndexBatchMs: init.indexTrace?.firstIndexBatchMs, indexCompleteMs: init.indexTrace?.indexCompleteMs,
        recordImportMs: init.indexTrace?.recordImportMs,
        decoderBackend: 'ffmpeg-wasm', firstFrameReadyMs: Math.round(performance.now() - openStart),
        firstPtsUs: Math.round((init.firstPts ?? init.ticks[0]) * 1e6 * init.tbNum / init.tbDen),
      });
      break;
    } catch (error) {
      lastError = error;
      loadAborted(deps.signal);
      if (error instanceof MediaOpenError && ['input', 'resource'].includes(error.stage)) { rpc.terminate(); throw error; }
      scoped.warn('media', 'WASM core 初始化失败，尝试下一个候选', { glueURL, error: error instanceof Error ? error.message : String(error) });
      init = null;
    } finally { detachAbort(); }
  }
  if (!init || !rpc) {
    rpc?.terminate();
    throw lastError ?? new Error('WASM 解码 core 不可用。');
  }

  if (!init.ticks.length || !init.tbNum || !init.tbDen) { rpc.terminate(); throw new Error('WASM 解码器未提供有效的首帧时间基准。'); }
  const firstTick = init.firstPts ?? init.ticks[0];
  const ticksToUs = (t: number) => Math.round(t * 1e6 * init.tbNum / init.tbDen);
  let ticks = init.ticks;
  let durationsTicks = init.durations;
  if (init.firstFrame) {
    ticks = [firstTick];
    durationsTicks = [init.firstFrame.duration];
  }
  let relUs = ticks.map(t => ticksToUs(t) - ticksToUs(firstTick));
  const frameDurationsUs = (times: number[], durations: number[]) => durations.map((d, i) => {
    const declared = ticksToUs(d);
    return declared > 0 ? declared : (i + 1 < times.length ? ticksToUs(times[i + 1] - times[i]) : (i > 0 ? ticksToUs(times[i] - times[i - 1]) : 0));
  });
  let durationsUs = frameDurationsUs(ticks, durationsTicks);
  const firstFrameDurationUs = Math.max(0, durationsUs[0] || 0);
  const initialDurationUs = Math.max(1, firstFrameDurationUs || 40_000);
  const initialStableCoverageUs = init.firstFrame ? Math.max(1, firstFrameDurationUs) : Math.max(1, relUs[relUs.length - 1] + durationsUs[durationsUs.length - 1]);
  const initialDuration = init.firstFrame ? initialDurationUs : initialStableCoverageUs;
  const info: MediaInfo = {
    id: randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
    codec: init.codec, decoder: 'ffmpeg-wasm', coreVariant, width: init.width, height: init.height,
    firstPtsUs: ticksToUs(firstTick), durationUs: initialDuration, stableCoverageUs: initialStableCoverageUs,
    pixelFormat: init.pixelFormat ?? null,
    color: ffmpegColorInfo(init),
    colorSource: 'decoder',
    indexSource: init.indexPending ? (indexUrl ? 'server' : 'client') : init.indexSource ?? 'client', indexState: init.indexPending ? 'building' : 'complete',
    indexKind: 'timestamps', seekAnchorCount: init.seekAnchorCount ?? 0,
    seekStrategy: init.seekAnchorCount ? 'demuxer-keyframe' : 'demuxer-timestamp',
  };

  let disposed = false;
  let spare: ArrayBuffer | null = null;
  let firstFrame = init.firstFrame;
  let previousIndex = -1;
  let referencePresentation = false;
  const indexWaiters = new Set<() => void>();
  const wakeIndex = () => { for (const resolve of indexWaiters) resolve(); indexWaiters.clear(); };
  const waitForIndexUpdate = () => new Promise<void>(resolve => indexWaiters.add(resolve));
  let source: MediaSource;
  const activeRpc = rpc;
  let containerSession: FfmpegContainerSession | undefined;
  let firstIndexBatchLogged = false;
  const applyIndexBatch = (result: { ctx: number; ticks: number[]; durations: number[]; stableCoverageUs: number; seekAnchorCount: number; buildId: string; indexIdentity?: MediaIndexIdentity; indexTrace?: MediaIndexClientTrace }) => {
    if (disposed || result.ctx !== init!.ctx) return;
    if (!firstIndexBatchLogged) {
      firstIndexBatchLogged = true;
      contextLog().info('media', '媒体管线追踪', {
        phase: 'first-index-batch', name: file.name, container: 'ffmpeg', demuxBackend: 'ffmpeg-wasm',
        indexBackend: 'server', indexIdentity: result.indexIdentity ?? init!.indexIdentity,
        indexBuildId: result.buildId, serverIndexRequests: result.indexTrace?.serverIndexRequests ?? init!.indexTrace?.serverIndexRequests ?? 0,
        firstIndexBatchMs: result.indexTrace?.firstIndexBatchMs, recordImportMs: result.indexTrace?.recordImportMs,
        decoderBackend: 'ffmpeg-wasm',
      });
    }
    const lastTick = ticks[ticks.length - 1];
    if (result.ticks.length !== result.durations.length || result.ticks.some(tick => !Number.isSafeInteger(tick))
      || (result.ticks.length && lastTick !== undefined && result.ticks[0] < lastTick)
      || !Number.isFinite(result.stableCoverageUs) || result.stableCoverageUs < 0) {
      activeRpc.terminate(new MediaOpenError('resource', '服务端 FFmpeg 索引 batch 破坏了呈现时间顺序。'));
      return;
    }
    if (result.ticks.length) {
      ticks.push(...result.ticks);
      durationsTicks.push(...result.durations);
      relUs = ticks.map(t => ticksToUs(t) - ticksToUs(firstTick));
      durationsUs = frameDurationsUs(ticks, durationsTicks);
    }
    const stableCoverageUs = Math.max(info.stableCoverageUs ?? 1, Math.floor(result.stableCoverageUs));
    containerSession?.index.updateCoverage(stableCoverageUs);
    updateMediaInfo(source, {
      stableCoverageUs,
      durationUs: Math.max(info.durationUs, stableCoverageUs),
      indexSource: 'server',
      seekAnchorCount: result.seekAnchorCount,
      seekStrategy: result.seekAnchorCount ? 'demuxer-keyframe' : 'demuxer-timestamp',
    }, 'index');
    wakeIndex();
  };
  const applyIndexComplete = (result: InitResult) => {
    if (disposed) return;
    if (!result.ticks.length || result.ticks[0] !== firstTick) {
      updateMediaInfo(source, { indexState: 'error', indexError: '完整索引改变了首帧时间轴起点。' }, 'index');
      wakeIndex();
      return;
    }
    ticks = result.ticks;
    durationsTicks = result.durations;
    relUs = ticks.map(t => ticksToUs(t) - ticksToUs(firstTick));
    durationsUs = frameDurationsUs(ticks, durationsTicks);
    const durationUs = Math.max(1, relUs[relUs.length - 1] + durationsUs[durationsUs.length - 1]);
    containerSession?.index.markComplete(durationUs);
    contextLog().info('media', 'FFmpeg 索引完成', {
      name: file.name, indexSource: result.indexSource, frames: ticks.length,
      firstPtsUs: info.firstPtsUs, durationUs, indexMs: result.indexMs,
      localIndexBuildCalls: result.localIndexBuildCalls ?? 0, seekAnchorCount: result.seekAnchorCount ?? 0,
    });
    contextLog().info('media', '媒体管线追踪', {
      phase: 'index-complete', name: file.name, container: 'ffmpeg', demuxBackend: 'ffmpeg-wasm',
      indexBackend: result.indexSource ?? info.indexSource, indexIdentity: result.indexIdentity ?? init!.indexIdentity,
      indexBuildId: result.indexTrace?.indexBuildId, serverIndexRequests: result.indexTrace?.serverIndexRequests ?? 0,
      firstIndexBatchMs: result.indexTrace?.firstIndexBatchMs, indexCompleteMs: result.indexTrace?.indexCompleteMs,
      recordImportMs: result.indexTrace?.recordImportMs,
      decoderBackend: 'ffmpeg-wasm', firstPtsUs: info.firstPtsUs, durationUs,
      stableCoverageUs: durationUs, seekAnchorCount: result.seekAnchorCount ?? 0,
    });
    updateMediaInfo(source, {
      durationUs, stableCoverageUs: durationUs, indexState: 'complete', indexSource: result.indexSource ?? info.indexSource,
      seekAnchorCount: result.seekAnchorCount ?? info.seekAnchorCount,
      seekStrategy: result.seekAnchorCount ? 'demuxer-keyframe' : 'demuxer-timestamp',
    }, 'index');
    wakeIndex();
  };
  const applyIndexError = (result: { error: string; stage?: OpenStage }) => {
    if (disposed) return;
    containerSession?.index.fail(result.error, false);
    updateMediaInfo(source, { indexState: 'error', indexError: result.error }, 'index');
    wakeIndex();
  };
  const currentIndexState = (): MediaInfo['indexState'] => info.indexState;
  const ensureIndexed = async (ptsUs = Infinity) => {
    if (disposed) throw new Error('媒体已释放。');
    if (containerSession) {
      await containerSession.index.ensure(ptsUs);
      if (disposed) throw new Error('媒体已释放。');
      return;
    }
    if (currentIndexState() === 'complete') return;
    if (currentIndexState() === 'error') {
      if (ptsUs < (info.stableCoverageUs ?? info.durationUs)) return;
      throw new Error(info.indexError ?? 'FFmpeg 索引失败。');
    }
    while (!disposed && currentIndexState() === 'building' && ptsUs >= (info.stableCoverageUs ?? info.durationUs)) await waitForIndexUpdate();
    if (disposed) throw new Error('媒体已释放。');
    if (currentIndexState() === 'error' && ptsUs >= (info.stableCoverageUs ?? info.durationUs)) throw new Error(info.indexError ?? 'FFmpeg 索引失败。');
  };
  const extract = async (index: number): Promise<WasmDecodedFrame> => {
    if (disposed) throw new Error('媒体已释放。');
    if (!Number.isInteger(index) || index < 0 || index >= ticks.length) throw new Error('帧索引无效。');
    const started = performance.now(), randomAccess = index !== previousIndex + 1;
    let output: WasmFrameOutput & { seek?: { decodedFrames: number; restarts: number } };
    if (index === 0 && firstFrame) {
      // The primed frame may first be consumed as a native-decoder witness,
      // before the player asks for its initial image. Keep the cache replayable
      // and give each caller a private buffer because returned buffers can be
      // recycled into the worker.
      output = { ...firstFrame, pixels: firstFrame.pixels.slice(0), seek: { decodedFrames: 0, restarts: 0 } };
    } else {
      const payload: Record<string, unknown> = { ctx: init.ctx, index };
      const transfer: Transferable[] = [];
      if (spare) { payload.recycle = spare; transfer.push(spare); spare = null; }
      try { output = await rpc.call<typeof output>('extract', payload, transfer); }
      catch (error) {
        scoped.warn('media', 'WASM 帧定位失败', { index, targetPtsUs: relUs[index], indexState: info.indexState, indexKind: info.indexKind, seekStrategy: info.seekStrategy, seekAnchorCount: info.seekAnchorCount, elapsedMs: Math.round(performance.now() - started), error: String(error) });
        throw error;
      }
    }
    previousIndex = index;
    if (randomAccess) scoped.info('media', 'WASM 帧定位完成', { index, targetPtsUs: relUs[index], elapsedMs: Math.round(performance.now() - started), seekStrategy: info.seekStrategy, ...output.seek });
    if (disposed) throw new Error('媒体已释放。');
    const pixels = new Uint8ClampedArray(output.pixels);
    validateDescription(output.description,pixels.byteLength);
    let closed = false;
    const decoded: WasmDecodedFrame = {
      kind: output.description.yuv ? 'yuv' : 'rgba8',
      description: output.description,
      width: output.description.width,
      height: output.description.height,
      byteSize: pixels.byteLength,
      pixels,
      ptsUs: ticksToUs(output.pts) - ticksToUs(firstTick),
      sourcePtsUs: ticksToUs(output.pts),
      durationUs: ticksToUs(output.duration) || durationsUs[index] || initialDurationUs,
      close() { if (!closed) { closed = true; if (!disposed) spare = pixels.buffer as ArrayBuffer; } },
    };
    if (referencePresentation && (decoded.kind !== 'yuv' || !resolveYuvColor(decoded.description).supported)) {
      const hdr = isHdrTransfer(decoded.description.color.transfer) || isHdrTransfer(info.color?.transfer);
      decoded.close();
      throw new MediaOpenError('decode', hdr ? '自有色彩目前仅支持 SDR，无法处理此 HDR 视频。请在“色彩与解码”中切换为“浏览器色彩”后重试。'
        : '自有色彩无法处理此视频的像素格式或颜色信息。请在“色彩与解码”中切换为“浏览器色彩”后重试。');
    }
    return decoded;
  };

  source = {
    info, ensureIndexed,
    async reconfigureColorMode(mode) {
      const previous = referencePresentation;
      referencePresentation = mode === 'reference';
      if (!referencePresentation) return;
      try { const frame = await source!.frameAt(0); frame.close(); }
      catch (error) { referencePresentation = previous; throw error; }
    },
    async admitReference() { await source!.reconfigureColorMode?.('reference', { decoder: 'software', depth: 1 }); return source!; },
    async frameAt(ptsUs) {
      await ensureIndexed(ptsUs);
      return extract(floorIndex(relUs, ptsUs));
    },
    async framesAfter(ptsUs, count) {
      if (count <= 0) return [];
      await ensureIndexed(ptsUs);
      while (info.indexState === 'building' && nextIndex(relUs, ptsUs) < 0) await waitForIndexUpdate();
      if (info.indexState === 'error' && nextIndex(relUs, ptsUs) < 0) throw new Error(info.indexError ?? 'FFmpeg 索引失败。');
      const start = nextIndex(relUs, ptsUs);
      if (start < 0) return [];
      const frames: WasmDecodedFrame[] = [];
      try {
        for (let i = start; i < Math.min(start + count, ticks.length); i++) frames.push(await extract(i));
        return frames;
      } catch (error) { for (const frame of frames) frame.close(); throw error; }
    },
    async *framesFrom(ptsUs) {
      await ensureIndexed(ptsUs);
      let idx = floorIndex(relUs, ptsUs);
      while (!disposed) {
        while (idx >= ticks.length && info.indexState === 'building') await waitForIndexUpdate();
        if (idx >= ticks.length) {
          if (info.indexState === 'error') throw new Error(info.indexError ?? 'FFmpeg 索引失败。');
          break;
        }
        yield await extract(idx++);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wakeIndex();
      firstFrame = undefined;
      spare = null;
      containerSession?.dispose();
      liveFallbacks--;
      activeRpc.setIndexHandlers(undefined);
      activeRpc.setIndexProgressHandler(undefined);
      activeRpc.terminate(undefined, false);
    },
  };
  activeRpc.setIndexHandlers({ batch: applyIndexBatch, complete: applyIndexComplete, error: applyIndexError });
  activeRpc.setIndexProgressHandler(progress => {
    if (!disposed) updateMediaInfo(source, { indexProgress: progress }, 'index');
  });
  if (init.indexPending && init.indexIdentity) {
    const sink: FfmpegIndexRecordSink = {
      manifest: (manifest, trace) => activeRpc.sendIndexManifest(init!.ctx, manifest, trace),
      batch: (batch, trace) => activeRpc.sendIndexBatch(init!.ctx, batch, trace),
      complete: (manifest, frames, trace) => activeRpc.sendIndexComplete(init!.ctx, manifest, frames, trace),
      legacy: (index, trace) => activeRpc.sendLegacyIndex(init!.ctx, index, trace),
      fallback: () => activeRpc.startLocalIndex(init!.ctx),
      progress: progress => { if (!disposed) updateMediaInfo(source, { indexProgress: progress }, 'index'); },
      error: message => activeRpc.reportIndexError(message),
    };
    containerSession = new FfmpegContainerSession(new FfmpegMediaIndexSession({
      url: indexUrl,
      identity: init.indexIdentity,
      firstPtsUs: info.firstPtsUs,
      durationUs: initialStableCoverageUs,
      sink,
    }));
  }
  return source;
}
