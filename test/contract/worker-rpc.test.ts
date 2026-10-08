import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker as NodeWorker } from 'node:worker_threads';
import { WorkerRpc } from '../../src/worker-rpc.ts';
import { workerReply } from '../../src/worker-protocol.ts';
import type { FfmpegInitResult, IndexBatch, PacketCommands } from '../../src/worker-protocol.ts';

function browserWorker() {
  const listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();
  const sent: { message: unknown; transfer?: Transferable[] }[] = [];
  let terminated = 0;
  const worker = {
    addEventListener(name: string, handler: (event: { data?: unknown; message?: string }) => void) { listeners.set(name, handler); },
    postMessage(message: unknown, transfer?: Transferable[]) { sent.push({ message, transfer }); },
    terminate() { terminated++; },
  } as unknown as Worker;
  return { worker, sent, get terminated() { return terminated; }, emit(data: unknown) { listeners.get('message')!({ data }); }, error(message: string) { listeners.get('error')!({ message }); } };
}
const init: FfmpegInitResult = { ctx: 1, path: '/test', ticks: [0], durations: [1], tbNum: 1, tbDen: 1, width: 1, height: 1, codec: 'test' };
const batch: IndexBatch = { ctx: 1, ticks: [1], durations: [1], stableCoverageUs: 2, seekAnchorCount: 1, buildId: '' };

test('Worker request and responder compile-time negative contracts remain enforced', () => {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('browser transport preserves request IDs, command payloads, transfers and reply results', async () => {
  const stub = browserWorker(), rpc = new WorkerRpc<PacketCommands>(stub.worker);
  const recycle = new ArrayBuffer(4);
  const pending = rpc.call('at', { pts: 42, recycle }, [recycle]);
  assert.deepEqual(stub.sent[0], { message: { id: 1, type: 'at', pts: 42, recycle }, transfer: [recycle] });
  stub.emit(workerReply<PacketCommands>()({ id: 1, type: 'at', pts: 42 }, null));
  assert.equal(await pending, null);
  rpc.terminate();
});

test('optional cache observations never occupy or fail video RPC requests', async () => {
  const stub = browserWorker(), rpc = new WorkerRpc<PacketCommands>(stub.worker);
  let observed = 0;
  rpc.onCachedAudio = generation => { observed = generation; };
  rpc.requestCachedAudio(42, 7);
  assert.deepEqual(stub.sent[0].message, { id: 0, type: 'cached-audio', pts: 42, generation: 7 });
  stub.emit({ id: 0, type: 'cached-audio', generation: 7, data: { packets: [] } });
  assert.equal(observed, 7);
  const post = stub.worker.postMessage.bind(stub.worker);
  stub.worker.postMessage = ((message: { type: string }, transfer?: Transferable[]) => {
    if (message.type === 'cached-audio') throw new Error('audio observation unavailable');
    post(message, transfer ?? []);
  }) as Worker['postMessage'];
  assert.doesNotThrow(() => rpc.requestCachedAudio(43, 8));
  const pending = rpc.call('at', { pts: 44 });
  assert.equal((stub.sent.at(-1)!.message as { id: number }).id, 1);
  stub.emit(workerReply<PacketCommands>()({ id: 1, type: 'at', pts: 44 }, null));
  assert.equal(await pending, null);
  rpc.terminate(); rpc.requestCachedAudio(45, 9);
  stub.emit({ id: 0, type: 'cached-audio', generation: 9, data: { packets: [] } });
  assert.equal(observed, 7);
});

test('browser errors reject all pending requests and termination is idempotent', async () => {
  const stub = browserWorker(); let released = 0;
  const rpc = new WorkerRpc(stub.worker, () => released++);
  const first = assert.rejects(rpc.call('extract', { ctx: 1, index: 0 }), /failed/);
  const second = assert.rejects(rpc.call('extract', { ctx: 1, index: 1 }), /failed/);
  stub.error('failed'); rpc.terminate();
  await Promise.all([first, second]);
  await assert.rejects(rpc.call('extract', { ctx: 1, index: 2 }), /failed/);
  assert.equal(stub.terminated, 1); assert.equal(released, 1);
});

test('cancelled requests close late transferred VideoFrames without resettling promises', async () => {
  const stub = browserWorker(), rpc = new WorkerRpc<PacketCommands>(stub.worker);
  const pending = assert.rejects(rpc.call('next', { pts: 0 }), /cancelled/);
  rpc.terminate(new Error('cancelled'));
  await pending;
  let closed = 0;
  stub.emit({ id: 1, ok: true, data: { frame: { close() { closed++; } } } });
  assert.equal(closed, 1); assert.equal(stub.terminated, 1);
});

for (const terminal of ['index-complete', 'index-error'] as const) test(`incremental ready/batch/${terminal} queues and filters request/build acknowledgements`, async () => {
  const stub = browserWorker(), rpc = new WorkerRpc(stub.worker);
  const pending = rpc.call('init', { glueURL: '', name: 'test' });
  stub.emit({ id: 1, type: 'ready', data: init }); assert.equal(await pending, init);
  rpc.startLocalIndex(1);
  assert.deepEqual(stub.sent[1].message, { id: 1, type: 'index-input', action: 'fallback', ctx: 1 });
  stub.emit({ id: 99, type: 'index-batch', data: batch });
  stub.emit({ id: 1, type: 'index-batch', data: { ...batch, buildId: 'stale' } });
  stub.emit({ id: 1, type: 'index-batch', data: batch });
  stub.emit({ id: 1, type: terminal, data: terminal === 'index-complete' ? init : { error: 'index failed', stage: 'resource' } });
  stub.emit({ id: 1, type: 'index-batch', data: batch });
  stub.emit({ id: 1, type: 'index-complete', data: init });
  const seen: string[] = [];
  rpc.setIndexHandlers({ batch: data => { assert.equal(data, batch); seen.push('batch'); }, complete: data => { assert.equal(data, init); seen.push('complete'); }, error: data => { assert.equal(data.error, 'index failed'); seen.push('error'); } });
  assert.deepEqual(seen, ['batch', terminal === 'index-complete' ? 'complete' : 'error']);
  rpc.terminate();
});

test('real Node worker_threads transport preserves transferred buffers and inferred replies', async () => {
  const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads'); parentPort.on('message', message => parentPort.postMessage({ id: message.id, ok: true, data: message.number }));`, { eval: true });
  const rpc = new WorkerRpc<PacketCommands>(worker as unknown as Worker);
  try {
    const bytes = new ArrayBuffer(4);
    const result = rpc.call('analysis-number', { axis: 'pts', number: 7 }, [bytes]);
    assert.equal(bytes.byteLength, 0); assert.equal(await result, 7);
  } finally { rpc.terminate(); }
});
for (const outcome of ['exit', 'error']) test(`real Node ${outcome} rejects outstanding and future requests`, async () => {
  const worker = new NodeWorker(outcome === 'exit' ? 'process.exit(3)' : 'throw new Error("worker crashed")', { eval: true });
  let released = 0; const rpc = new WorkerRpc(worker as unknown as Worker, () => released++);
  await assert.rejects(rpc.call('extract', { ctx: 1, index: 0 }), outcome === 'exit' ? /exit 3/ : /worker crashed/);
  await assert.rejects(rpc.call('extract', { ctx: 1, index: 1 }), /worker 异常/);
  rpc.terminate(); assert.equal(released, 1);
});
