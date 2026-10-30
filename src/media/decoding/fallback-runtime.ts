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

