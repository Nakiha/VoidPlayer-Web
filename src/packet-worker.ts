import { Mp4Engine } from './mp4-engine.ts';
import { FlvEngine } from './flv-engine.ts';
import { MediaOpenError } from './media-errors.ts';
import type { FlvInput } from './flv-demux.ts';

async function start() {
  // The production path uses the browser Worker; Node exercises this same
  // demux/decoder implementation with the real WASM binary.
  const parent = typeof process !== 'undefined' && process.versions?.node
    ? (await import('node:worker_threads')).parentPort : null;
  const send = (value: unknown, transfer: Transferable[] = []) => parent ? parent.postMessage(value, { transfer: transfer as ArrayBuffer[] }) : (globalThis as unknown as { postMessage(v: unknown, t: Transferable[]): void }).postMessage(value, transfer);
  let engine: FlvEngine | Mp4Engine | undefined;
  let chain = Promise.resolve();
  const receive = (message: { id: number; type: string; input: FlvInput; glueURL: string; wasmBinary?: Uint8Array; forceWasm?: boolean; container?: 'flv' | 'mp4'; threads?: number; position: number; recycle?: ArrayBuffer }) => {
    chain = chain.then(async () => {
      const { id, type } = message;
      try {
        if (type === 'init') {
          engine?.close(); engine = message.container === 'mp4' ? new Mp4Engine(message.input) : new FlvEngine(message.input);
          send({ id, ok: true, data: await engine.open(message.glueURL, message.wasmBinary, message.forceWasm, message.threads) });
        } else if (type === 'dispose') {
          engine?.close(); engine = undefined; send({ id, ok: true, data: null });
        } else if (type === 'extract' && engine) {
          const result = await engine.extract(message.position, message.recycle);
          try { send({ id, ok: true, data: result }, result.frame ? [result.frame] : [result.pixels!]); }
          finally { result.frame?.close(); }
        } else throw new MediaOpenError('input', '压缩包 worker 未初始化。');
      } catch (error) {
        send({ id, ok: false, error: error instanceof Error ? error.message : String(error), stage: error instanceof MediaOpenError ? error.stage : 'decode' });
      }
    });
  };
  if (parent) parent.on('message', receive);
  else globalThis.onmessage = e => receive(e.data);
}
void start();
