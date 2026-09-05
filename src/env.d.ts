declare const __BUILD_INFO__: { revision: string; builtAt: string };

// WebWorker-scope API used by the WASM fallback's chunked reader; absent from
// the page's DOM lib but present in every browser worker (and absent in Node,
// which the code detects at runtime).
declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}
