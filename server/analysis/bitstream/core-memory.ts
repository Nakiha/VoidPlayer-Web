type WasmMemory = { readonly buffer: ArrayBufferLike };
type WasmImports = Record<string, Record<string, unknown>>;
type WasmInstance = { readonly exports: object };
// Node's server type environment intentionally excludes DOM declarations.
type WasmRuntime = {
  compile(bytes: Uint8Array<ArrayBuffer>): Promise<object>;
  Memory: new (options: { initial: number; maximum?: number; shared?: boolean }) => WasmMemory;
  Instance: new (module: object, imports: WasmImports) => WasmInstance;
};

/** Pthread growth does not resize the main thread's fixed SharedArrayBuffer view. */
export async function createThreadedAnalysisCore(
  factory: (options: Record<string, any>) => Promise<any>, wasmBinary: Uint8Array<ArrayBuffer>, analysisThreads: number,
) {
  const wasm = (globalThis as unknown as { WebAssembly?: WasmRuntime }).WebAssembly;
  if (!wasm) throw new Error('Threaded analysis requires WebAssembly');
  const compiled = await wasm.compile(wasmBinary);
  let memory: WasmMemory | undefined;
  const core = await factory({
    wasmBinary, analysisThreads,
    instantiateWasm(imports: WasmImports, receive: (instance: WasmInstance, module: object) => void) {
      memory = Object.values(imports).flatMap(namespace => Object.values(namespace)).find(value => value instanceof wasm.Memory) as WasmMemory | undefined;
      if (!memory) throw new Error('Threaded analysis core must import its WASM memory');
      const instance = new wasm.Instance(compiled, imports);
      receive(instance, compiled);
      return instance.exports;
    },
  });
  let heap: Uint8Array = core.HEAPU8;
  Object.defineProperty(core, 'HEAPU8', {
    configurable: true, enumerable: true,
    get() {
      const buffer = memory!.buffer;
      if (heap.buffer !== buffer || heap.byteLength !== buffer.byteLength) heap = new Uint8Array(buffer);
      return heap;
    },
    set(value: Uint8Array) { heap = value; },
  });
  return core;
}
