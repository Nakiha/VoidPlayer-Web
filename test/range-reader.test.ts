import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { RangeReader } from '../src/range-reader.ts';
import { createRangeBridge } from '../src/range-bridge.ts';
import { WorkerRpc } from '../src/ffmpeg-media.ts';

test('Range cache is bounded, pinned to a file version and validates response bodies', async t => {
  let requests = 0, invalid = '', cancelled = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++;
    const range = (options.headers as Record<string, string>).Range;
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!, start = +a, end = +b;
    if (invalid === 'whole') return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
    const length = end - start + 1 + (invalid === 'overflow' ? 1 : invalid === 'short' ? -1 : 0);
    return new Response(new Uint8Array(length).fill(start / 262144), { status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/16777216`, ETag: invalid === 'version' ? '"new"' : '"old"' } });
  });
  const reader = new RangeReader({ url: 'https://test.invalid/video', size: 16 * 1024 ** 2 });
  try {
    await reader.read(0, 10); await reader.read(10, 10); assert.equal(requests, 1);
    for (let i = 1; i <= 33; i++) assert.equal((await reader.read(i * 262144, 1))[0], i);
    const before = requests; await reader.read(0, 1); assert.equal(requests, before + 1, 'evicts beyond 8 MiB');
    for (const mode of ['whole', 'version', 'overflow', 'short']) {
      invalid = mode; await assert.rejects(reader.read(15 * 1024 ** 2, 1));
    }
    assert.equal(cancelled, 1, '200 body cancelled before any read');
  } finally { reader.close(); }
});

test('Synchronous FFmpeg AVIO requests bounded chunks through the async bridge and preserves IO errors', { timeout: 30000 }, async t => {
  const bytes = await readFile(new URL('../fixtures/video/ffv1_yuv422p_8bit.mkv', import.meta.url));
  const core = new URL('../public/vendor/voidplayer-core/', import.meta.url);
  let requests = 0, fail = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++;
    if (fail) return new Response(null, { status: 503 });
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    assert.ok(+b - +a < 262144);
    return new Response(bytes.subarray(+a, +b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` } });
  });
  for (const failing of [false, true]) {
    fail = failing;
    const worker = new Worker(new URL('../src/ffmpeg-worker.ts', import.meta.url));
    const bridge = createRangeBridge(worker as unknown as globalThis.Worker, 'https://test.invalid/video', bytes.length);
    const rpc = new WorkerRpc(worker as unknown as globalThis.Worker, () => bridge.close());
    try {
      const pending = rpc.call<{ ctx: number; ticks: number[]; ioMode: string }>('init', {
        glueURL: new URL('voidplayer-core.js', core).href, wasmBinary: await readFile(new URL('voidplayer-core.wasm', core)), range: { size: bytes.length, shared: bridge.shared },
      });
      if (failing) { await assert.rejects(pending, /503/); continue; }
      const init = await pending; assert.equal(init.ioMode, 'http-range'); assert.ok(init.ticks.length > 1);
      const frame = await rpc.call<import('../src/wasm-frame.ts').WasmFrameOutput>('extract', { ctx: init.ctx, index: 1 });
      assert.equal(frame.pixels.byteLength, 320 * 180 * 4); assert.ok(new Set(new Uint8Array(frame.pixels).subarray(0, 4096)).size > 2);
    } finally { rpc.terminate(); }
  }
  assert.ok(requests >= 2);
});
