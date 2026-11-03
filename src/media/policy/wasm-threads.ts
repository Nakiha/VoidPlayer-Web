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

export const VVC_THREAD_OPTIONS = [2, 4, 6, 8] as const;
export const VVC_FRAME_CONTEXT_LIMIT = 6;
export type VvcThreadMode = 'auto' | `${typeof VVC_THREAD_OPTIONS[number]}`;
export type DecodeThreads = number | { general: number; vvc: number };
const vvcKey = 'voidplayer.vvc-thread-mode';
let vvcMode: VvcThreadMode | undefined;

function parseVvcMode(value: string | null): VvcThreadMode {
  return VVC_THREAD_OPTIONS.some(threads => String(threads) === value) ? value as VvcThreadMode : 'auto';
}

export function vvcThreadMode(): VvcThreadMode {
  if (vvcMode !== undefined) return vvcMode;
  try { return parseVvcMode(globalThis.localStorage?.getItem(vvcKey) ?? null); }
  catch { return 'auto'; }
}

export function setVvcThreadMode(value: string) {
  vvcMode = parseVvcMode(value);
  try { globalThis.localStorage?.setItem(vvcKey, vvcMode); }
  catch { /* Keep the selection in memory when storage is unavailable. */ }
}

export function decodeThreadsForCodec(threads: DecodeThreads, codec: string): number {
  return typeof threads === 'number' ? threads : codec === 'vvc' ? threads.vvc : threads.general;
}
