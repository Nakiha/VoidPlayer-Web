import type { DecodedFrame, MediaSource } from './media.ts';
import type { MediaInfo } from './model.ts';

// FFmpeg-WASM fallback media source for tracks mediabunny/WebCodecs cannot
// demux or decode (FFV1, MPEG-2 TS, H.266/VVC, H.264 4:2:2, ...). The
// self-built core runs inside a Web Worker (`src/ffmpeg-worker.ts`): decode is
// synchronous CPU work and must stay off the UI thread. Pixels come back as
// transferred buffers; the frame index travels once at open.

const MAX_FALLBACK_FILE_BYTES = 512 * 1024 * 1024;

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
}

async function createWorker(): Promise<Worker> {
  if (typeof Worker !== 'undefined') return new Worker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module' });
  // Node tests: worker_threads with the same message surface.
  const { Worker: NodeWorker } = await import('node:worker_threads');
  return new NodeWorker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module' } as object) as unknown as Worker;
}

class WorkerRpc {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(worker: Worker) {
    this.worker = worker;
    const onMessage = (data: { id: number; ok: boolean; data: unknown; error?: string }) => {
      const { id, ok, data: payload, error } = data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(payload); else entry.reject(new Error(error ?? 'WASM 解码器错误'));
    };
    const fail = (message: string) => {
      const error = new Error(`WASM 解码 worker 异常：${message}`);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyWorker = worker as any;
    if (typeof anyWorker.addEventListener === 'function') {
      anyWorker.addEventListener('message', (e: { data: unknown }) => onMessage(e.data as never));
      anyWorker.addEventListener('error', (e: { message?: string }) => fail(e.message ?? 'unknown'));
    } else {
      anyWorker.on('message', onMessage);
      anyWorker.on('error', (e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    }
  }
  call<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }
  terminate() { this.worker.terminate(); }
}

export async function openFFmpegMedia(file: File, deps: FallbackDeps = {}): Promise<MediaSource> {
  if (file.size > MAX_FALLBACK_FILE_BYTES) {
    throw new Error(`文件超过 WASM 回退解码的 ${MAX_FALLBACK_FILE_BYTES / 1024 / 1024} MiB 内存上限。`);
  }
  const worker = deps.workerFactory?.() ?? await createWorker();
  const rpc = new WorkerRpc(worker);
  let init: InitResult;
  try {
    const glueURL = deps.glueURL ?? new URL(`/${WASM_CORE_GLUE_PATH}`, location.origin).href;
    const initPayload: Record<string, unknown> = { glueURL, name: file.name, file: await file.arrayBuffer() };
    const transfer: Transferable[] = [initPayload.file as ArrayBuffer];
    if (deps.wasmBinary) {
      initPayload.wasmBinary = deps.wasmBinary.buffer as ArrayBuffer;
      transfer.push(initPayload.wasmBinary as ArrayBuffer);
    }
    init = await rpc.call<InitResult>('init', initPayload, transfer);
  } catch (error) {
    rpc.terminate();
    throw error;
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
    id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified,
    codec: init.codec, decoder: 'ffmpeg-wasm', width: init.width, height: init.height,
    firstPtsUs: firstUs, durationUs: relUs[total - 1] + durations[total - 1],
  };

  let disposed = false;
  // Drawn frames return their pixel buffer to the next extract (ping-pong),
  // so playback does not allocate megabytes per frame.
  let spare: ArrayBuffer | null = null;
  const extract = async (index: number): Promise<WasmDecodedFrame> => {
    if (disposed) throw new Error('媒体已释放。');
    const payload: Record<string, unknown> = { ctx: init.ctx, ticks, index };
    const transfer: Transferable[] = [];
    if (spare) { payload.recycle = spare; transfer.push(spare); spare = null; }
    const buffer = await rpc.call<ArrayBuffer>('extract', payload, transfer);
    const pixels = new Uint8ClampedArray(buffer);
    return {
      pixels,
      ptsUs: relUs[index],
      sourcePtsUs: ticksToUs(ticks[index]),
      durationUs: durations[index],
      draw(canvas) {
        if (canvas.width !== info.width) canvas.width = info.width;
        if (canvas.height !== info.height) canvas.height = info.height;
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) throw new Error('浏览器无法创建画布。');
        ctx2d.putImageData(new ImageData(pixels, info.width, info.height), 0, 0);
      },
      close() { spare = pixels.buffer as ArrayBuffer; },
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
      void rpc.call('dispose', { ctx: init.ctx, path: init.path }).finally(() => rpc.terminate());
    },
  };
}
