/** Capture the actual memory through Emscripten's public instantiation hook.
 * A pthread can grow shared memory without refreshing Module.HEAPU8 in this
 * worker. External callers must get a current view from memory.buffer instead.
 */
export async function instantiateCore(factory: (options: Record<string, unknown>) => Promise<any>, binary: Uint8Array) {
  const module = await WebAssembly.compile(binary as Uint8Array<ArrayBuffer>);
  let memory: WebAssembly.Memory | undefined;
  const core = await factory({ wasmBinary: binary, instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
    const instance = new WebAssembly.Instance(module, imports);
    const memories = new Set([...Object.values(instance.exports), ...Object.values(imports).flatMap(Object.values)].filter(value => value instanceof WebAssembly.Memory));
    if (memories.size !== 1) throw new Error('WASM core 必须提供唯一的线性内存。');
    memory = [...memories][0] as WebAssembly.Memory;
    receive(instance, module);
    return instance.exports;
  } });
  if (!memory) throw new Error('WASM core 未调用内存初始化接口。');
  const heap = liveHeap(memory);
  return { core, heap };
}

export function liveHeap(memory: WebAssembly.Memory): () => Uint8Array {
  let view = new Uint8Array(memory.buffer);
  return () => {
    const buffer = memory.buffer;
    if (view.buffer !== buffer || view.byteLength !== buffer.byteLength) view = new Uint8Array(buffer);
    return view;
  };
}
