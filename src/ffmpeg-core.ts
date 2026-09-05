// Loader around the Emscripten FFmpeg core (single-threaded @ffmpeg/core build).
// The core executes synchronously on the calling thread and is used only as a
// decode fallback for tracks that mediabunny/WebCodecs cannot handle. The
// fallback needs no WebCodecs and no cross-origin isolation headers.

export interface FFmpegCore {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  exec(...args: string[]): void;
  setLogger(logger: (entry: { type: string; message: string }) => void): void;
  ret: number;
}

export type FFmpegCoreFactory = (options: { wasmBinary?: Uint8Array }) => Promise<FFmpegCore>;

let corePromise: Promise<FFmpegCore> | null = null;

// Tests inject create/wasmBinary to run the same core under Node; each override
// call builds a fresh instance. The browser path is a lazy singleton so the
// ~30 MB wasm is fetched and compiled only when a fallback decode is needed.
export function loadFFmpegCore(overrides?: { create?: FFmpegCoreFactory; wasmBinary?: Uint8Array }): Promise<FFmpegCore> {
  if (overrides?.create || overrides?.wasmBinary) {
    if (!overrides.create || !overrides.wasmBinary) {
      return Promise.reject(new Error('FFmpeg core 测试注入必须同时提供 create 和 wasmBinary。'));
    }
    return overrides.create({ wasmBinary: overrides.wasmBinary });
  }
  return corePromise ??= (async () => {
    const [{ default: create }, { default: wasmURL }] = await Promise.all([
      import('@ffmpeg/core'),
      import('@ffmpeg/core/wasm?url'),
    ]);
    const wasmBinary = new Uint8Array(await (await fetch(wasmURL)).arrayBuffer());
    return (create as FFmpegCoreFactory)({ wasmBinary });
  })();
}
