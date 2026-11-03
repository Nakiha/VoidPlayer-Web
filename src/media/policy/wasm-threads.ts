export type WasmThreadMode = 'auto' | 'single-thread' | 'multi-thread';

const key = 'voidplayer.wasm-thread-mode';
let mode: WasmThreadMode | undefined;

function parse(value: string | null): WasmThreadMode {
  return value === 'single-thread' || value === 'multi-thread' ? value : 'auto';
}

export function wasmThreadMode(): WasmThreadMode {
  if (mode !== undefined) return mode;
  try { return parse(globalThis.localStorage?.getItem(key) ?? null); }
  catch { return 'auto'; }
}

export function setWasmThreadMode(value: string) {
  mode = parse(value);
  try { globalThis.localStorage?.setItem(key, mode); }
  catch { /* Keep the selection in memory when storage is unavailable. */ }
}

export const MAX_WASM_DECODE_COUNT = 0x7fffffff;
export type DecodeThreads = number | { general: number; vvc: number; vvcFrameContexts: number };
const vvcThreadsKey = 'voidplayer.vvc-thread-mode';
const vvcContextsKey = 'voidplayer.vvc-frame-contexts';
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
