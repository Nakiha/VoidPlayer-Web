import { randomUUID } from './uuid.ts';
import { MediaOpenError } from './media-errors.ts';
import type { OpenStage } from './media-errors.ts';
import type { DecodedFrame, MediaSource } from './media.ts';
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
  ioMode?: 'blob' | 'memfs';
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(worker: Worker) {
    this.worker = worker;
    const onMessage = (data: { id: number; ok: boolean; data: unknown; error?: string; stage?: OpenStage }) => {
      const { id, ok, data: payload, error } = data;
      const entry = this.pending.get(id);
      if (!entry) {
        // A transferable VideoFrame may arrive after cancellation.
        (payload as { frame?: VideoFrame } | null)?.frame?.close();
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (ok) entry.resolve(payload); else entry.reject(data.stage ? new MediaOpenError(data.stage, error ?? '解码器错误') : new Error(error ?? 'WASM 解码器错误'));
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
  call<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[] = [], timeoutMs = 15000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(new Error(`WASM ${type} 超时（${timeoutMs} ms）`)), timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { this.terminate(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  terminate(error = new Error('WASM worker 已释放。')) {
    if (this.failure) return;
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.worker.terminate();
  }
}

export async function openFFmpegMedia(file: File, deps: FallbackDeps = {}): Promise<MediaSource> {
  const openStart = performance.now();
  liveFallbacks++;
  try {
    return await openFFmpegMediaInner(file, deps, openStart);
  } catch (error) {
    liveFallbacks--;
    throw error;
  }
}

async function openFFmpegMediaInner(file: File, deps: FallbackDeps, openStart: number): Promise<MediaSource> {
  // The Blob crosses into the worker by reference; there the custom AVIO
  // reads it in chunks via FileReaderSync, so the file never enters WASM
  // memory at all. Environments without FileReaderSync (Node tests) buffer
  // the whole file in the worker and enforce the byte cap there.
  if (file.size > MAX_FALLBACK_FILE_BYTES && typeof File === 'undefined') {
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
    rpc?.terminate();
    rpc = new WorkerRpc(deps.workerFactory?.() ?? await createWorker());
    try {
      const payload: Record<string, unknown> = { glueURL, name: file.name, threads, blob: file };
      const transfer: Transferable[] = [];
      if (deps.wasmBinary) {
        payload.wasmBinary = new Uint8Array(deps.wasmBinary).buffer;
        transfer.push(payload.wasmBinary as ArrayBuffer);
      }
      init = await rpc.call<InitResult>('init', payload, transfer, 5000);
      coreVariant = glueURL.includes('core-mt.') ? 'multi-thread' : 'single-thread';
      scoped.info('media', 'WASM core 已就绪', {
        coreVariant, crossOriginIsolated: !!globalThis.crossOriginIsolated,
        ioMode: init.ioMode, readMs, initIndexMs: init.indexMs, threads,
      });
      break;
    } catch (error) {
      lastError = error;
      scoped.warn('media', 'WASM core 初始化失败，尝试下一个候选', { glueURL, error: error instanceof Error ? error.message : String(error) });
      init = null;
    }
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
      close() { if (!closed) { closed = true; spare = pixels.buffer as ArrayBuffer; } },
    };
  };

  return {
    info,
    frameAt: ptsUs => extract(floorIndex(relUs, ptsUs)),
    async framesAfter(ptsUs, count) {
      const start = nextIndex(relUs, ptsUs);
      if (start < 0) return [];
      const frames: WasmDecodedFrame[] = [];
      for (let i = start; i < Math.min(start + count, total); i++) frames.push(await extract(i));
      return frames;
    },
    async *framesFrom(ptsUs) {
      for (let idx = floorIndex(relUs, ptsUs); idx < total && !disposed; idx++) yield await extract(idx);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveFallbacks--;
      rpc.terminate();
    },
  };
}
