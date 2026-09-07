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
import { ffmpegColorInfo } from './media-metadata.ts';

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
  path: string;
  ticks: number[];
  durations: number[];
  tbNum: number;
  tbDen: number;
  width: number;
  height: number;
  codec: string;
  indexMs?: number;
  ioMode?: 'blob' | 'memfs' | 'http-range';
  colorPrimaries?: number;
  colorTransfer?: number;
  colorSpace?: number;
  colorRange?: number;
  pixelFormat?: string | null;
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
  private worker: Worker;
  private nextId = 1;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; refresh?: () => void }>();
  private onTerminate: () => void;
  constructor(worker: Worker, onTerminate: () => void = () => {}, onProgress?: MediaOpenProgress) {
    this.onTerminate = onTerminate;
    this.worker = worker;
    const onMessage = (data: { id: number; ok: boolean; data: unknown; error?: string; stack?: string; stage?: OpenStage; type?: string; progress?: MediaLoadStage }) => {
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
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (ok) entry.resolve(payload);
      else {
        const failure = data.stage ? new MediaOpenError(data.stage, error ?? '解码器错误') : new Error(error ?? 'WASM 解码器错误');
        if (data.stack) failure.stack += `\nWorker: ${data.stack}`;
        contextLog().warn('media', '解码 worker 请求失败', { error: failure });
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
  call<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[] = [], timeoutMs = 15000, idleTimeout = false): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const expire = () => this.terminate(new Error(`WASM ${type} 超时（${timeoutMs} ms）`));
      const entry = { resolve: resolve as (v: unknown) => void, reject, timer: setTimeout(expire, timeoutMs),
        refresh: idleTimeout ? () => { clearTimeout(entry.timer); entry.timer = setTimeout(expire, timeoutMs); } : undefined };
      this.pending.set(id, entry);
      try { this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { this.terminate(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  terminate(error = new Error('WASM worker 已释放。')) {
    if (this.failure) return;
    this.failure = error;
    this.onTerminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.worker.terminate();
  }
}

type FallbackInput = File | (MediaMeta & { url: string });

export async function openFFmpegMediaFromUrl(url: string, meta: MediaMeta, deps: FallbackDeps = {}): Promise<MediaSource> {
  loadAborted(deps.signal);
  const { openPacketMedia } = await import('./packet-media.ts');
  try {
    return await openPacketMedia('mp4', { url, size: meta.size }, meta, { ...deps, forceWasm: true });
  } catch (error) {
    loadAborted(deps.signal);
    // Only a demux/codec capability gap can select FFmpeg's container path.
    // Network, resource and packet decoding failures must remain visible.
    if (!(error instanceof MediaOpenError) || !['container', 'codec'].includes(error.stage)) throw error;
    contextLog().info('media', 'MP4 压缩包路径不可用，使用 FFmpeg Range 解封装', { reason: error.message });
  }
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
      const payload: Record<string, unknown> = { glueURL, name: file.name, threads,
        ...('url' in file ? { range: { shared: bridge!.shared, size: file.size } } : { blob: file }) };
      const transfer: Transferable[] = [];
      if (deps.wasmBinary) {
        payload.wasmBinary = new Uint8Array(deps.wasmBinary).buffer;
        transfer.push(payload.wasmBinary as ArrayBuffer);
      }
      // Includes fetching/compiling the core and scanning the file's index.
      // Five seconds is not a viable cold-start budget over a LAN.
      deps.onProgress?.('decoder');
      init = await rpc.call<InitResult>('init', payload, transfer, 60000);
      coreVariant = glueURL.includes('core-mt.') ? 'multi-thread' : 'single-thread';
      scoped.info('media', 'WASM core 已就绪', {
        coreVariant, crossOriginIsolated: !!globalThis.crossOriginIsolated,
        ioMode: init.ioMode, readMs, initIndexMs: init.indexMs, threads,
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

  const { ticks, tbNum, tbDen } = init;
  if (!tbNum || !tbDen) { rpc.terminate(); throw new Error('WASM 解码器未提供有效的时间基准。'); }
  const total = ticks.length;
  const ticksToUs = (t: number) => Math.round(t * 1e6 * tbNum / tbDen);
  const firstUs = ticksToUs(ticks[0]);
  const relUs = ticks.map(t => ticksToUs(t) - firstUs);
  const durations = init.durations.map((d, i) => {
    const declared = ticksToUs(d);
    return declared > 0 ? declared : (i + 1 < total ? relUs[i + 1] - relUs[i] : (i > 0 ? relUs[i] - relUs[i - 1] : 0));
  });
  const info: MediaInfo = {
    id: randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
    codec: init.codec, decoder: 'ffmpeg-wasm', coreVariant, width: init.width, height: init.height,
    firstPtsUs: firstUs, durationUs: relUs[total - 1] + durations[total - 1],
    pixelFormat: init.pixelFormat ?? null,
    color: ffmpegColorInfo(init),
    colorSource: 'decoder',
  };

  let disposed = false;
  // Drawn frames return their pixel buffer to the next extract (ping-pong),
  // so playback does not allocate megabytes per frame.
  let spare: ArrayBuffer | null = null;
  const extract = async (index: number): Promise<WasmDecodedFrame> => {
    if (disposed) throw new Error('媒体已释放。');
    const payload: Record<string, unknown> = { ctx: init.ctx, index };
    const transfer: Transferable[] = [];
    if (spare) { payload.recycle = spare; transfer.push(spare); spare = null; }
    const buffer = await rpc.call<ArrayBuffer>('extract', payload, transfer);
    const pixels = new Uint8ClampedArray(buffer);
    let closed = false;
    return {
      kind: 'rgba8',
      width: init.width,
      height: init.height,
      byteSize: pixels.byteLength,
      pixels,
      ptsUs: relUs[index],
      sourcePtsUs: ticksToUs(ticks[index]),
      durationUs: durations[index],
      close() { if (!closed) { closed = true; if (!disposed) spare = pixels.buffer as ArrayBuffer; } },
    };
  };

  return {
    info,
    frameAt: ptsUs => extract(floorIndex(relUs, ptsUs)),
    async framesAfter(ptsUs, count) {
      const start = nextIndex(relUs, ptsUs);
      if (start < 0) return [];
      const frames: WasmDecodedFrame[] = [];
      try {
        for (let i = start; i < Math.min(start + count, total); i++) frames.push(await extract(i));
        return frames;
      } catch (error) { for (const frame of frames) frame.close(); throw error; }
    },
    async *framesFrom(ptsUs) {
      for (let idx = floorIndex(relUs, ptsUs); idx < total && !disposed; idx++) yield await extract(idx);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      spare = null;
      liveFallbacks--;
      rpc.terminate();
    },
  };
}
