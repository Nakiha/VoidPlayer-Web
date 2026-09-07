import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { liveHeap } from '../src/wasm-core.ts';
import { checkedHeap } from '../src/flv-decoder.ts';

for (const shared of [false, true]) test(`live WASM heap survives ${shared ? 'other-thread shared' : 'detached nonshared'} memory growth`, async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared });
  const heap = liveHeap(memory), old = heap(); old[16] = 42;
  if (shared) {
    const worker = new Worker("const {parentPort,workerData}=require('node:worker_threads'); workerData.grow(2); parentPort.postMessage('grown');", { eval: true, workerData: memory });
    try { await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); }); }
    finally { await worker.terminate(); }
    assert.equal(old.byteLength, 65536); // Valid but too short, just like stale Module.HEAPU8.
  } else { memory.grow(2); assert.equal(old.byteLength, 0); }
  assert.equal(heap().byteLength, 3*65536); assert.equal(heap()[16], 42);
  checkedHeap(heap(), 2*65536, 4, '测试写入').set([1,2,3,4], 2*65536);
  assert.deepEqual([...new Uint8Array(memory.buffer, 2*65536, 4)], [1,2,3,4]);
  assert.throws(() => checkedHeap(heap(), 3*65536, 1, '越界'), /内存范围无效/);
});
