// Web Worker hosting the self-built FFmpeg WASM core. Decoding is synchronous
// CPU work; it must never run on the UI thread. The page talks to this worker
// over a small RPC: init (open + demux-only index) and extract (exact-PTS RGBA
// frame). Pixel buffers are transferred, never copied.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Dual environment: web worker (browser) and node:worker_threads (tests).
// Messages queue until the initial script evaluation completes in both
// environments, so wiring the listener from a microtask is race-free.
const port: any = (() => {
  const scope = globalThis as any;
  if (!scope.process?.versions?.node) return scope;
  const shim: { onmessage: null | ((event: { data: any }) => void) } = { onmessage: null };
  let parent: any = null;
  void import('node:worker_threads').then(({ parentPort }) => {
    if (!parentPort) throw new Error('worker_threads parentPort 不可用');
    parent = parentPort;
    parentPort.on('message', (data: any) => shim.onmessage?.({ data }));
  });
  return {
    get onmessage() { return shim.onmessage; },
    set onmessage(fn) { shim.onmessage = fn; },
    postMessage: (message: any, transfer?: any[]) => parent?.postMessage(message, transfer),
  };
})();

let core: any = null;
const contexts = new Map<number, number[]>();

async function init(payload: { glueURL: string; wasmBinary: ArrayBuffer; name: string; file: ArrayBuffer }) {
  const mod = await import(payload.glueURL);
  core = await mod.default({ wasmBinary: new Uint8Array(payload.wasmBinary) });
  const ctx = core.ccall('vp_create', 'number', [], []);
  if (!ctx) throw new Error('无法创建 WASM 解码上下文。');
  const path = `/vp-in-${crypto.randomUUID()}`;
  try {
    core.FS.writeFile(path, new Uint8Array(payload.file));
    if (core.ccall('vp_open', 'number', ['number', 'string'], [ctx, path]) !== 0) {
      throw new Error('FFmpeg WASM 也无法读取该文件的视频轨道。');
    }
    const count = core.ccall('vp_index_build', 'number', ['number'], [ctx]) as number;
    if (count <= 0) throw new Error('FFmpeg WASM 无法建立该文件的帧索引。');
    const ticks: number[] = new Array(count);
    const durations: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      ticks[i] = Number(core.ccall('vp_index_ticks', 'i64', ['number', 'number'], [ctx, i]));
      durations[i] = Number(core.ccall('vp_index_duration', 'i64', ['number', 'number'], [ctx, i]));
    }
    contexts.set(ctx, ticks);
    return {
      ctx, path, ticks, durations,
      tbNum: core.ccall('vp_tb_num', 'number', ['number'], [ctx]),
      tbDen: core.ccall('vp_tb_den', 'number', ['number'], [ctx]),
      width: core.ccall('vp_width', 'number', ['number'], [ctx]),
      height: core.ccall('vp_height', 'number', ['number'], [ctx]),
      codec: core.ccall('vp_codec_name', 'string', ['number'], [ctx]),
    };
  } catch (error) {
    try { core.FS.unlink(path); } catch { /* best effort */ }
    core.ccall('vp_destroy', null, ['number'], [ctx]);
    throw error;
  }
}

function extract(ctx: number, index: number, recycle?: ArrayBuffer) {
  const ticks = contexts.get(ctx);
  if (!ticks || !Number.isInteger(index) || index < 0 || index >= ticks.length) throw new Error('帧索引无效。');
  const target = BigInt(ticks[index]);
  const result = core.ccall('vp_extract', 'number', ['number', 'i64'], [ctx, target]);
  if (result !== 1 || Number(core.ccall('vp_last_ticks', 'i64', ['number'], [ctx])) !== ticks[index]) {
    throw new Error(`WASM 解码未能命中索引帧 ${index}（结果 ${result}）。`);
  }
  const width = core.ccall('vp_width', 'number', ['number'], [ctx]);
  const height = core.ccall('vp_height', 'number', ['number'], [ctx]);
  const ptr = core.ccall('vp_pixels', 'number', ['number'], [ctx]);
  const len = width * height * 4;
  // Reuse the client's recycled buffer when it fits: at 60 fps an 8 MB frame
  // allocation per extract is pure GC churn.
  const out = recycle && recycle.byteLength === len ? new Uint8Array(recycle) : new Uint8Array(len);
  out.set(core.HEAPU8.subarray(ptr, ptr + len));
  return out.buffer;
}

port.onmessage = async (event: { data: any }) => {
  const { id, type, ...payload } = event.data;
  try {
    if (type === 'init') {
      port.postMessage({ id, ok: true, data: await init(payload) });
    } else if (type === 'extract') {
      const buffer = extract(payload.ctx, payload.index, payload.recycle);
      port.postMessage({ id, ok: true, data: buffer }, [buffer]);
    } else if (type === 'dispose') {
      const ctx = payload.ctx;
      if (contexts.delete(ctx)) {
        try { core.FS.unlink(payload.path); } catch { /* already gone */ }
        core.ccall('vp_destroy', null, ['number'], [ctx]);
      }
      port.postMessage({ id, ok: true, data: null });
    } else {
      throw new Error(`未知消息类型: ${type}`);
    }
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
