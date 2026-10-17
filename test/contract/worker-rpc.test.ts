import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker as NodeWorker } from 'node:worker_threads';
import { WorkerRpc } from '../../src/media/workers/worker-rpc.ts';
import { workerReply } from '../../src/media/workers/worker-protocol.ts';
import type { FfmpegInitResult, IndexBatch, PacketCommands } from '../../src/media/workers/worker-protocol.ts';

function browserWorker() {
  const listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();
  const sent: { message: unknown; transfer?: Transferable[] }[] = [];
  let terminated = 0;
  const worker = {
    addEventListener(name: string, handler: (event: { data?: unknown; message?: string }) => void) { listeners.set(name, handler); },
    postMessage(message: unknown, transfer?: Transferable[]) { sent.push({ message, transfer }); },
    terminate() { terminated++; },
  } as unknown as Worker;
  return { worker, sent, get terminated() { return terminated; }, emit(data: unknown) { listeners.get('message')!({ data }); }, error(message: string) { listeners.get('error')!({ message }); }, messageError() { listeners.get('messageerror')?.({}); } };
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

test('decoder failure retains the core compatibility code across worker transport', async () => {
  const stub = browserWorker(), rpc = new WorkerRpc<PacketCommands>(stub.worker);
  const pending = rpc.call('at', { pts: 42 });
  stub.emit({ id: 1, ok: false, stage: 'decode', code: 'wasm-core-incompatible', error: 'WASM packet configuration ABI unavailable' });
  await assert.rejects(pending, error => {
    assert.equal((error as any).stage, 'decode');
    assert.equal((error as any).code, 'wasm-core-incompatible');
    return true;
  });
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

test('cache byte replies, timeout and teardown remain independent of video RPC deadlines', async () => {
  const stub = browserWorker(), rpc = new WorkerRpc<PacketCommands>(stub.worker);
  const bytes = rpc.requestCachedBytes(100, 4);
  const request = stub.sent.at(-1)!.message as { id: number };
  stub.emit({ id: request.id, type: 'cached-bytes', data: Uint8Array.of(1, 2, 3, 4) });
  assert.deepEqual(await bytes, Uint8Array.of(1, 2, 3, 4));
  const video = rpc.call('at', { pts: 44 }, [], 5000);
  assert.equal(await rpc.requestCachedBytes(200, 4), undefined, 'missing optional reply expires quietly');
  assert.equal(stub.terminated, 0);
  stub.emit(workerReply<PacketCommands>()({ id: 1, type: 'at', pts: 44 }, null)); assert.equal(await video, null);
  const late = rpc.requestCachedBytes(300, 4); rpc.terminate(); assert.equal(await late, undefined);
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

test('browser messageerror rejects video/index requests promptly and releases optional byte waits', async () => {
  const stub = browserWorker(); let released = 0;
  const rpc = new WorkerRpc(stub.worker,()=>released++);
  const ready = rpc.call('init',{glueURL:'',name:'test'});
  stub.emit({id:1,type:'ready',data:init}); await ready;
  const indexFailures:string[]=[];
  rpc.setIndexHandlers({error:error=>{indexFailures.push(error.error);}});
  const first=rpc.call('extract',{ctx:1,index:0},[],1000);
  const second=rpc.call('extract',{ctx:1,index:1},[],1000);
  const bytes=rpc.requestCachedBytes(0,4);
  const settled=Promise.allSettled([first,second,bytes]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    stub.messageError();
    const result=await Promise.race([settled,new Promise<'still pending'>(resolve=>{timer=setTimeout(()=>resolve('still pending'),40);})]);
    assert.notEqual(result,'still pending','deserialization failure must settle without waiting for a decode timeout');
    assert.ok(Array.isArray(result));
    for(const request of result.slice(0,2)){assert.equal(request.status,'rejected');if(request.status==='rejected')assert.match(request.reason.message,/reply|反序列化/);}
    assert.deepEqual(result[2],{status:'fulfilled',value:undefined});
    assert.equal(Reflect.get(rpc,'pending').size,0);assert.equal(Reflect.get(rpc,'byteRequests').size,0);
    assert.equal(indexFailures.length,1);assert.match(indexFailures[0],/reply|反序列化/);assert.equal(released,1);assert.equal(stub.terminated,1);
    stub.messageError();rpc.terminate();assert.equal(indexFailures.length,1);assert.equal(released,1);
    await assert.rejects(rpc.call('extract',{ctx:1,index:2}),/reply|反序列化/);
    let closed=0;stub.emit({id:2,ok:true,data:{frame:{close(){closed++;}}}});assert.equal(closed,1);
  } finally {clearTimeout(timer);rpc.terminate();await settled;}
});

test('Node messageerror uses the same pending cleanup and terminal scope', async () => {
  const worker=new NodeWorker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{});`,{eval:true});
  let released=0;
  const rpc=new WorkerRpc(worker as unknown as Worker,()=>released++);
  const first=assert.rejects(rpc.call('extract',{ctx:1,index:0},[],1000),/Invalid worker reply/);
  const second=assert.rejects(rpc.call('extract',{ctx:1,index:1},[],1000),/Invalid worker reply/);
  worker.emit('messageerror',new Error('bad serialized reply'));
  await Promise.all([first,second]);
  assert.equal(Reflect.get(rpc,'pending').size,0);assert.equal(released,1);
  await assert.rejects(rpc.call('extract',{ctx:1,index:2}),/Invalid worker reply/);
  rpc.terminate();assert.equal(released,1);
});

test('postMessage failure terminates only its RPC and rejects other pending work', async () => {
  const failed=browserWorker(),healthy=browserWorker();
  const a=new WorkerRpc<PacketCommands>(failed.worker),b=new WorkerRpc<PacketCommands>(healthy.worker);
  try {
    const first=assert.rejects(a.call('next',{pts:0}),/cannot transfer/);
    failed.worker.postMessage=()=>{throw new Error('cannot transfer');};
    await assert.rejects(a.call('at',{pts:1}),/cannot transfer/);await first;
    assert.equal(Reflect.get(a,'pending').size,0);assert.equal(failed.terminated,1);
    const other=b.call('next',{pts:0});healthy.emit(workerReply<PacketCommands>()({id:1,type:'next',pts:0},null));
    assert.equal(await other,null);assert.equal(healthy.terminated,0,'independent worker survives');
  } finally {a.terminate();b.terminate();}
});

for(const hook of ['index','terminate'] as const)test(`a throwing ${hook} hook cannot strand latched-failure requests or their worker`,async()=>{
  const stub=browserWorker();let releases=0;
  const rpc=new WorkerRpc(stub.worker,()=>{releases++;if(hook==='terminate')throw new Error('terminate hook failed');});
  const ready=rpc.call('init',{glueURL:'',name:'test'});stub.emit({id:1,type:'ready',data:init});await ready;
  rpc.setIndexHandlers({error:()=>{if(hook==='index')throw new Error('index hook failed');}});
  const waiting=rpc.call('extract',{ctx:1,index:0},[],1000);
  const settled=waiting.then(()=>assert.fail('failed request cannot fulfill'),error=>{assert.match(error.message,/original fault/);});
  try {
    assert.throws(()=>rpc.terminate(new Error('original fault')),new RegExp(`${hook} hook failed`));
    assert.equal(Reflect.get(rpc,'pending').size,0,'pending cleanup follows callback failure');
    assert.equal(stub.terminated,1);assert.equal(releases,1);await settled;
    await assert.rejects(rpc.call('extract',{ctx:1,index:1}),/original fault/);
    rpc.terminate();assert.equal(stub.terminated,1);assert.equal(releases,1);
  }finally{
    // Keep the old-head negative probe bounded even when its latched failure
    // prevents the ordinary deadline from settling the stranded promise.
    const pending=Reflect.get(rpc,'pending');for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('original fault'));}pending.clear();await settled;
  }
});

test('synchronous postMessage failure preserves hook diagnostics even after the request Promise settles', async()=>{
  const stub=browserWorker();
  const ownerError=new Error('owner hook failed'),indexError=new Error('index hook failed'),postError=new Error('post failed');
  let releases=0;
  const rpc=new WorkerRpc(stub.worker,()=>{releases++;throw ownerError;});
  const ready=rpc.call('init',{glueURL:'',name:'diagnostic'});stub.emit({id:1,type:'ready',data:init});await ready;
  rpc.setIndexHandlers({error(){throw indexError;}});
  stub.worker.postMessage=()=>{throw postError;};
  await assert.rejects(rpc.call('extract',{ctx:1,index:0}),error=>error===postError);
  assert.deepEqual(rpc.terminationCallbackErrors,[indexError,ownerError]);
  assert.equal(Object.isFrozen(rpc.terminationCallbackErrors),true);
  assert.equal(Reflect.get(rpc,'pending').size,0);assert.equal(releases,1);assert.equal(stub.terminated,1);
  await assert.rejects(rpc.call('extract',{ctx:1,index:1}),error=>error===postError);
});
