import { coreAssetUrl } from './core-url.ts';
import { VVC_EXPERIMENTAL_CAPACITY, vvcFrameContextCount, vvcThreadCount, wasmThreadMode,
  type DecodeThreads, type WasmThreadMode } from '../policy/wasm-threads.ts';
import type {MediaOpenProgress} from '../progress.ts';
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

export function fallbackCoreCandidates(deps: FallbackDeps, base: string, mode: WasmThreadMode): string[] {
  if (deps.glueURL) return [deps.glueURL];
  const single = coreAssetUrl(WASM_CORE_GLUE_PATH, base);
  return mode !== 'single-thread' && !deps.wasmBinary && globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
    ? [coreAssetUrl(WASM_CORE_GLUE_PATH_MT, base), single] : [single];
}

export function fallbackCoreVariant(glueURL: string) {
  return glueURL.includes('core-mt.') ? 'multi-thread' : 'single-thread';
}

export function fallbackDecodeThreads(budget: DecodeThreads, glueURL: string, mode: WasmThreadMode, explicitCore = false): DecodeThreads {
  const multi = fallbackCoreVariant(glueURL) === 'multi-thread';
  if (!multi && !explicitCore) return 1;
  if (!multi || mode !== 'auto-grow' || typeof budget === 'number') return budget;
  return { ...budget, vvcTuning: { contexts: VVC_EXPERIMENTAL_CAPACITY,
    threads: Math.max(budget.vvc, Math.min(VVC_EXPERIMENTAL_CAPACITY, globalThis.navigator?.hardwareConcurrency ?? budget.vvc)) } };
}

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

// Reserve CPU headroom for presentation, then share the remaining budget across fallback tracks.
let liveFallbacks = 0;
let reservedFallbackThreads = 0;
export function reserveFallbackThreads(mode = wasmThreadMode()) {
  liveFallbacks++;
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  const available = cores - 2;
  const share = Math.max(1, Math.min(Math.floor(available / liveFallbacks), available - reservedFallbackThreads));
  // VVC only creates its growable executor when opened with at least two threads.
  const minimum = mode === 'auto-grow' && cores > 1 ? 2 : 1;
  const vvc = (mode === 'manual' ? vvcThreadCount() : 0) || Math.min(6, Math.max(minimum, share));
  const contexts = (mode === 'manual' ? vvcFrameContextCount() : 0) || Math.min(6, vvc);
  const threads = mode === 'single-thread' ? { general: 1, vvc: 1, vvcFrameContexts: 1 }
    : { general: Math.min(4, share), vvc, vvcFrameContexts: contexts };
  const reserved = Math.max(threads.general, threads.vvc);
  reservedFallbackThreads += reserved;
  let released = false;
  return { threads, release() {
    if (released) return;
    released = true;
    liveFallbacks--;
    reservedFallbackThreads -= reserved;
  } };
}
