import type { WasmThreadMode } from '../contract.ts';
export type { WasmThreadMode } from '../contract.ts';

const key = 'voidplayer.wasm-thread-mode-v2';
let mode: WasmThreadMode | undefined;

export function wasmThreadMode(): WasmThreadMode {
  if (mode !== undefined) return mode;
  try {
    const saved = globalThis.localStorage?.getItem(key);
    if (saved === 'auto' || saved === 'auto-grow' || saved === 'manual' || saved === 'single-thread') return saved;
    // Older builds stored the overrides and growth switch independently.
    if (globalThis.localStorage?.getItem('voidplayer.wasm-thread-mode') === 'single-thread') return 'single-thread';
    if (vvcThreadCount() || vvcFrameContextCount()) return 'manual';
    if (readVvcCount(vvcLiveGrowthKey) === 1) return 'auto-grow';
  } catch { /* Storage can be unavailable. */ }
  return 'auto';
}

export function setWasmThreadMode(value: WasmThreadMode) {
  mode = value;
  try { globalThis.localStorage?.setItem(key, value); }
  catch { /* Keep the selection in memory when storage is unavailable. */ }
}

export const MAX_WASM_DECODE_COUNT = 0x7fffffff;
export type DecodeThreads = number | { general: number; vvc: number; vvcFrameContexts: number; vvcTuning?: { contexts: number; threads: number } };
export const VVC_EXPERIMENTAL_CAPACITY = 12;
const vvcThreadsKey = 'voidplayer.vvc-thread-mode';
const vvcContextsKey = 'voidplayer.vvc-frame-contexts';
const vvcLiveGrowthKey = 'voidplayer.vvc-live-growth';
const vvcTuning = new Map<string, number>();

function readVvcCount(key: string) {
  if (vvcTuning.has(key)) return vvcTuning.get(key)!;
  try { return parseVvcCount(globalThis.localStorage?.getItem(key)); }
  catch { return 0; }
}

function parseVvcCount(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const count = Number(value);
  return count <= MAX_WASM_DECODE_COUNT ? count : 0;
}

function writeVvcCount(key: string, value: string) {
  const count = parseVvcCount(value);
  vvcTuning.set(key, count);
  try { globalThis.localStorage?.setItem(key, count ? String(count) : 'auto'); }
  catch { /* Keep the selection in memory when storage is unavailable. */ }
}

export function vvcThreadCount() { return readVvcCount(vvcThreadsKey); }
export function vvcFrameContextCount() { return readVvcCount(vvcContextsKey); }
export function setVvcThreadCount(value: string) { writeVvcCount(vvcThreadsKey, value); }
export function setVvcFrameContextCount(value: string) { writeVvcCount(vvcContextsKey, value); }

export function decodeThreadsForCodec(threads: DecodeThreads, codec: string): number {
  return typeof threads === 'number' ? threads : codec === 'vvc' ? threads.vvc : threads.general;
}
