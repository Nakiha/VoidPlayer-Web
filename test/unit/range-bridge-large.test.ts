import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRangeBridge } from '../../src/media/io/range-bridge.ts';

test('File bridge preserves bounded startup metadata after LRU eviction without observer IO', {timeout:15000}, async t => {
  const data = new Uint8Array(9 * 1024 ** 2).map((_,i) => i % 251), file = new Blob([data]), slice = file.slice.bind(file);
  let reads = 0;
  t.mock.method(file, 'slice', (start = 0, end = file.size) => { reads++; return slice(start,end); });
  const worker = new Worker(new URL('../range-bridge-worker.ts', import.meta.url));
  const bridge = createRangeBridge(worker as unknown as globalThis.Worker, {file});
  try {
    const result = new Promise<{bytes?:ArrayBuffer;error?:string}>(resolve => worker.on('message', message => {
      if (message.type === 'result') resolve(message);
    }));
    worker.postMessage({shared:bridge.shared,size:file.size,start:0,end:file.size});
    const response = await result;
    assert.equal(response.error, undefined); assert.deepEqual(new Uint8Array(response.bytes!),data);
    const consumed = reads;
    assert.deepEqual(bridge.peek(0,65536),data.slice(0,65536));
    assert.deepEqual(bridge.peek(64000,32000),data.slice(64000,96000));
    assert.equal(bridge.peek(-1,1),undefined);
    assert.ok(bridge.cachedWindows().reduce((sum,window) => sum+window.length,0) <= 8*1024**2+128*1024);
    assert.equal(reads,consumed,'metadata observation is cache-only');
    bridge.close(); assert.deepEqual(bridge.cachedWindows(),[]); assert.equal(bridge.peek(0,1),undefined); assert.equal(bridge.peek(0,0),undefined);
  } finally { bridge.close(); await worker.terminate(); }
});

for (const mode of ['large', 'eof', 'past-eof', 'cancel', 'short', 'version', 'limit', 'invalid']) test(`synchronous Range bridge: ${mode}`, { timeout: 15000 }, async t => {
  const start = 2 ** 32 + 123, length = mode === 'limit' ? 65 * 1024 * 1024 : 9 * 1024 * 1024 + 17, size = start + length;
  const worker = new Worker(new URL('../range-bridge-worker.ts', import.meta.url));
  const bridge = createRangeBridge(worker as unknown as globalThis.Worker, { url: 'https://test.invalid/large', size });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++;
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec((options.headers as Record<string, string>).Range)!;
    assert.ok(+b - +a + 1 <= 256 * 1024);
    if (mode === 'cancel' && requests === 3) bridge.close();
    const data = new Uint8Array(+b - +a + 1 - (mode === 'short' && requests === 3 ? 1 : 0));
    for (let i = 0; i < data.length; i++) data[i] = (+a + i) % 251;
    return new Response(data, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${size}`, ETag: mode === 'version' && requests === 3 ? '"changed"' : '"original"' } });
  });
  try {
    const result = new Promise<{ bytes?: ArrayBuffer; error?: string }>(resolve => worker.on('message', message => { if (message.type === 'result') resolve(message); }));
    worker.postMessage({ shared: bridge.shared, size, start: mode === 'invalid' ? -1 : mode === 'eof' ? size : mode === 'past-eof' ? size + 1000 : start, end: size + 1000 });
    const response = await result;
    if (['cancel', 'short', 'version', 'limit', 'invalid'].includes(mode)) { assert.ok(response.error); assert.equal(response.bytes, undefined); }
    else {
      const bytes = new Uint8Array(response.bytes!);
      assert.equal(bytes.length, mode === 'large' ? length : 0);
      for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], (start + i) % 251);
      if (mode !== 'large') assert.equal(requests, 0);
    }
  } finally { bridge.close(); await worker.terminate(); }
});
