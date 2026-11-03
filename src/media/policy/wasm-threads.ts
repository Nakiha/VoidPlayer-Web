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
