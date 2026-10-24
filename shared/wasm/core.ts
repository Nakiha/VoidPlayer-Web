import type * as Wasm from './runtime-types.d.ts';
declare const WebAssembly: typeof Wasm;
/** Capture the actual memory through Emscripten's public instantiation hook.
 * A pthread can grow shared memory without refreshing Module.HEAPU8 in this
 * worker. External callers must get a current view from memory.buffer instead.
 */
export async function instantiateCore(factory: (options: Record<string, unknown>) => Promise<any>, binary: Uint8Array, maxMemoryBytes?: number) {
  const module = await WebAssembly.compile(binary as Uint8Array<ArrayBuffer>);
  let memory: Wasm.Memory | undefined;
  const core = await factory({ wasmBinary: binary, instantiateWasm(imports: Wasm.Imports, receive: (instance: Wasm.Instance, module: Wasm.Module) => void) {
    const instance = new WebAssembly.Instance(module, imports);
    const memories = new Set([...Object.values(instance.exports), ...Object.values(imports).flatMap(Object.values)].filter(value => value instanceof WebAssembly.Memory));
    if (memories.size !== 1) throw new Error('WASM core 必须提供唯一的线性内存。');
    memory = [...memories][0] as Wasm.Memory;
    if (maxMemoryBytes !== undefined) limitMemoryGrowth(memory, maxMemoryBytes);
    receive(instance, module);
    return instance.exports;
  } });
  if (!memory) throw new Error('WASM core 未调用内存初始化接口。');
  const heap = liveHeap(memory);
  return { core, heap };
}

export function liveHeap(memory: Wasm.Memory): () => Uint8Array {
  let view = new Uint8Array(memory.buffer);
  return () => {
    const buffer = memory.buffer;
    if (view.buffer !== buffer || view.byteLength !== buffer.byteLength) view = new Uint8Array(buffer);
    return view;
  };
}

/** Optional per-instance cap for pinned Emscripten cores, whose allocator grows
 * through the JS memory.grow method. Does not alter uncapped playback instances. */
export class WasmMemoryBudgetError extends Error {
  constructor() { super('WASM memory budget exceeded'); this.name = 'WasmMemoryBudgetError'; }
}
export function limitMemoryGrowth(memory: Wasm.Memory, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || memory.buffer.byteLength > maxBytes) throw new WasmMemoryBudgetError();
  const grow = memory.grow.bind(memory);
  Object.defineProperty(memory, 'grow', { value(pages: number) {
    if (!Number.isSafeInteger(pages) || pages < 0 || memory.buffer.byteLength + pages * 65536 > maxBytes) throw new WasmMemoryBudgetError();
    return grow(pages);
  } });
}
