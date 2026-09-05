// Loader for the self-built VoidPlayer WASM decoder core (trimmed FFmpeg
// n9.0.1, see the VoidPlayer-FFmpeg-Build repo, branch `wasm`). The core runs
// synchronously on the calling thread and is used only as a decode fallback
// for tracks that mediabunny/WebCodecs cannot handle. It needs no WebCodecs
// and no cross-origin isolation headers.

export interface FFmpegCore {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  HEAPU8: Uint8Array;
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
}

export interface FFmpegCoreModule {
  default: (options?: { wasmBinary?: Uint8Array }) => Promise<FFmpegCore>;
}

export const WASM_CORE_GLUE_PATH = 'vendor/voidplayer-core/voidplayer-core.js';

let corePromise: Promise<FFmpegCore> | null = null;

// Tests inject the module/wasmBinary to run the same core under Node; each
// override call builds a fresh instance. The browser path is a lazy singleton
// so the wasm is fetched and compiled only when a fallback decode is needed.
export function loadFFmpegCore(overrides?: { module?: Promise<FFmpegCoreModule>; wasmBinary?: Uint8Array }): Promise<FFmpegCore> {
  if (overrides?.module || overrides?.wasmBinary) {
    if (!overrides.module || !overrides.wasmBinary) {
      return Promise.reject(new Error('FFmpeg core 测试注入必须同时提供 module 和 wasmBinary。'));
    }
    return overrides.module.then(m => m.default({ wasmBinary: overrides.wasmBinary }));
  }
  return corePromise ??= (async () => {
    // Served from public/ so the Emscripten glue resolves its .wasm sibling
    // via import.meta.url without bundler involvement.
    const glueURL = new URL(WASM_CORE_GLUE_PATH, document.baseURI).href;
    const { default: create } = (await import(/* @vite-ignore */ glueURL)) as FFmpegCoreModule;
    return create();
  })();
}
