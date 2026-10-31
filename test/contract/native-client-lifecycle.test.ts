import { BrowserWorker } from '../helpers/browser-worker-host.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once, getEventListeners, EventEmitter } from 'node:events';
import { NativeAnalysisClient } from '../../src/analysis/metadata/native-client.ts';

test('browser metadata messageerror releases pending, abort and transport listeners without affecting a second client',async()=>{
  const listeners=new Map<string,Function>();let stopped=0,posted!:()=>void;
  const posting=new Promise<void>(resolve=>{posted=resolve;});
  const fake={addEventListener(name:string,fn:Function){listeners.set(name,fn);},removeEventListener(name:string,fn:Function){if(listeners.get(name)===fn)listeners.delete(name);},postMessage(){posted();},terminate(){stopped++;}} as unknown as globalThis.Worker;
  const client=new NativeAnalysisClient(()=>fake),signal=new AbortController();
  const request=client.call('rank',{firstPtsUs:0,axis:'pts',tUs:0},signal.signal);void request.catch(()=>{});
  try {
    await posting;assert.equal(getEventListeners(signal.signal,'abort').length,1);listeners.get('messageerror')!();
    await assert.rejects(request,/Invalid native analysis worker reply/);
    assert.equal(Reflect.get(client,'pending').size,0);assert.equal(stopped,1);assert.equal(listeners.size,0);assert.equal(getEventListeners(signal.signal,'abort').length,0);
    signal.abort();client.close();assert.equal(stopped,1);
    await assert.rejects(client.call('rank',{firstPtsUs:0,axis:'pts',tUs:0}),/Invalid native analysis worker reply/);
    const healthy=new NativeAnalysisClient();
    try {assert.equal((await healthy.call('rank',{firstPtsUs:0,axis:'pts',tUs:0})).total,0);}finally{healthy.close();}
  } finally {client.close();}
});

test('real Node metadata messageerror settles callers and exits with no remaining listeners',async()=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>parentPort.postMessage({event:'received',id:m.id}));`,{eval:true});
  const client=new NativeAnalysisClient(()=>worker as unknown as globalThis.Worker);
  const received=once(worker,'message');
  const request=client.call('rank',{firstPtsUs:0,axis:'pts',tUs:0});void request.catch(()=>{});
  try {
    let timer:ReturnType<typeof setTimeout>;
    try{await Promise.race([received,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('real metadata request not received')),1500);})]);}finally{clearTimeout(timer!);}
    assert.equal(Reflect.get(client,'pending').size,1);
    const exited=once(worker,'exit');worker.emit('messageerror',new Error('injected deserialization failure'));
    assert.equal(Reflect.get(client,'pending').size,0,'handler must settle synchronously rather than await its30s deadline');
    await assert.rejects(request,/Invalid native analysis worker reply/);await exited;await Promise.resolve();
    for(const name of ['message','error','exit','messageerror'])assert.equal(worker.listenerCount(name),0,`${name}: client listener released`);
    await assert.rejects(client.call('rank',{firstPtsUs:0,axis:'pts',tUs:0}),/Invalid native analysis worker reply/);
  } finally {client.close();await worker.terminate();}
});

for(const outcome of ['resolve','reject'] as const)test(`controlled Node termination ${outcome} removes only this client's callbacks after settlement`,async()=>{
  const worker=new EventEmitter();
  let posted!:(value?:unknown)=>void,ended!:(value?:unknown)=>void,rejectEnd!:(error:Error)=>void,stopped=0;
  const posting=new Promise(resolve=>{posted=resolve;});
  const termination=new Promise((resolve,reject)=>{ended=resolve;rejectEnd=reject;});
  Object.assign(worker,{postMessage(){posted();},terminate(){stopped++;return termination;}});
  const names=['message','error','exit','messageerror'];
  const external=new Map(names.map(name=>[name,()=>{}]));
  for(const [name,callback]of external)worker.on(name,callback);
  const client=new NativeAnalysisClient(()=>worker as unknown as globalThis.Worker),abort=new AbortController();
  const request=client.call('rank',{firstPtsUs:0,axis:'pts',tUs:0},abort.signal);void request.catch(()=>{});
  try{
    await posting;
    const owned=new Map(names.map(name=>[name,worker.listeners(name).find(callback=>callback!==external.get(name))!]));
    for(const name of names){assert.equal(worker.listenerCount(name),2);assert.ok(owned.get(name));}
    worker.emit('messageerror',new Error('synthetic deserialization event'));
    assert.equal(stopped,1);assert.equal(Reflect.get(client,'pending').size,0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
    await assert.rejects(request,/Invalid native analysis worker reply/);
    for(const name of names)assert.ok(worker.listeners(name).includes(owned.get(name)!),`${name}: owned callback must remain until termination settles`);
    assert.doesNotThrow(()=>worker.emit('error',new Error('late thread error before settlement')));
    client.close();assert.equal(stopped,1);
    if(outcome==='resolve')ended(0);else rejectEnd(new Error('synthetic termination rejection'));
    await new Promise(resolve=>setImmediate(resolve));
    for(const name of names)assert.deepEqual(worker.listeners(name),[external.get(name)],`${name}: only the external callback remains`);
    assert.doesNotThrow(()=>worker.emit('error',new Error('external listener survives')));
  }finally{ended(0);client.close();}
});

test('Node browser host turns an unexpected physical exit into a browser transport failure', async () => {
  const worker = new BrowserWorker(
    new URL('data:text/javascript,' + encodeURIComponent("const {parentPort}=await import('node:worker_threads'); parentPort.close();")),
  );
  const client = new NativeAnalysisClient(() => worker as unknown as globalThis.Worker);
  try {
    await assert.rejects(client.call('rank', { firstPtsUs: 0, axis: 'pts', tUs: 0 }), /Worker exited unexpectedly/);
    await new Promise((resolve) => setImmediate(resolve));
    for (const event of ['message', 'error', 'messageerror', 'exit']) assert.equal(worker.listenerCount(event), 0);
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('Node browser host supports self, property handlers and transferable reply options', async () => {
  const entry = 'self.onmessage=e=>self.postMessage(e.data,{transfer:[e.data]});';
  const worker = new BrowserWorker(new URL('data:text/javascript,' + encodeURIComponent(entry)));
  try {
    const reply = new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => reject(e.error ?? Error(e.message));
    });
    const bytes = new Uint8Array([4, 9, 16]);
    worker.postMessage(bytes.buffer, [bytes.buffer]);
    assert.equal(bytes.byteLength, 0);
    assert.deepEqual([...new Uint8Array(await reply)], [4, 9, 16]);
    worker.onmessage = null;
    worker.onerror = null;
    assert.equal(worker.listenerCount('message'), 0);
    assert.equal(worker.listenerCount('exit'), 0);
  } finally {
    await worker.terminate();
  }
});
