import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once, getEventListeners } from 'node:events';
import { NativeAnalysisClient } from '../../src/analysis/native-client.ts';

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

test('real Node metadata messageerror settles callers and detaches client listeners after thread termination',async()=>{
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
