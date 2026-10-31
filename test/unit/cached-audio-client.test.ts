import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCachedContainerAudio } from '../../src/media/audio/cached-audio-client.ts';
import type { MediaSource } from '../../src/media/contract.ts';

class FakeWorker {
  static instances:FakeWorker[]=[];
  static failType:string|undefined;
  failType:string|undefined;
  onmessage:((event:{data:any})=>void)|null=null;
  onerror:(()=>void)|null=null;
  onmessageerror:(()=>void)|null=null;
  terminated=0;
  messages:any[]=[];
  constructor(){this.failType=FakeWorker.failType;FakeWorker.instances.push(this);}
  postMessage(message:any,transfer:ArrayBuffer[]=[]){if(message.type===this.failType)throw new Error("injected postMessage failure");this.messages.push(structuredClone(message,{transfer}));}
  terminate(){this.terminated++;}
}
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));};
function source(){let closed=0;const media={info:{size:1000,container:'mpegts',firstPtsUs:900},close(){closed++;}} as unknown as MediaSource;return {media,closed:()=>closed};}

test('deserialization failure tears down only cached audio and discards late callbacks',async()=>{
  const original=globalThis.Worker;globalThis.Worker=FakeWorker as unknown as typeof Worker;
  const {media,closed}=source();let audio=0;media.onCachedAudio=()=>{audio++;};
  let release!:(bytes:Uint8Array)=>void;const bytes=new Uint8Array([1,2,3]);
  const stop=attachCachedContainerAudio(media,()=>new Promise(resolve=>{release=resolve;}));
  try {
    media.requestCachedAudio!(1,7);const worker=FakeWorker.instances.at(-1)!;
    const lateMessage=worker.onmessage!;
    lateMessage({data:{type:'peek',id:4,offset:0,length:3}});
    worker.onmessageerror?.();
    assert.equal(worker.terminated,1,'messageerror terminates the optional parser immediately');
    assert.equal(worker.onmessage,null);assert.equal(worker.onerror,null);assert.equal(worker.onmessageerror,null);
    release(bytes);await settle();assert.equal(bytes.byteLength,3,'late reply was not transferred');
    lateMessage({data:{type:'audio',generation:7,batch:{packets:[]}}});assert.equal(audio,0);
    const count=FakeWorker.instances.length;media.requestCachedAudio!(2,8);assert.equal(FakeWorker.instances.length,count);
    assert.equal(closed(),0,'video source remains owned by playback');stop();assert.equal(worker.terminated,1);
  } finally {stop();globalThis.Worker=original;}
});

for(const channel of ['peek','windows'] as const) test(`asynchronous ${channel} reply post failure is contained and disables only audio`,async()=>{
  const original=globalThis.Worker;globalThis.Worker=FakeWorker as unknown as typeof Worker;
  const {media,closed}=source();let release!:(value:any)=>void;
  const gate=new Promise<any>(resolve=>{release=resolve;});
  const bytes=new Uint8Array([4,5,6]);
  const stop=attachCachedContainerAudio(media,()=>gate,undefined,()=>gate);
  try {
    media.requestCachedAudio!(100,12);const current=FakeWorker.instances.at(-1)!;
    current.failType=channel==='peek'?'bytes':'windows';
    current.onmessage!({data:{type:channel,id:17,offset:0,length:3}});
    release(channel==='peek'?bytes:[{offset:0,length:3}]);await settle();
    assert.equal(current.terminated,1);assert.equal(current.onmessage,null);assert.equal(current.onerror,null);assert.equal(current.onmessageerror,null);
    assert.equal(bytes.byteLength,3,'failed transfer leaves caller bytes owned locally');
    assert.equal(closed(),0);const count=FakeWorker.instances.length;media.requestCachedAudio!(200,13);assert.equal(FakeWorker.instances.length,count);
  } finally {stop();globalThis.Worker=original;}
});

for(const failure of ['init','query'])test(`synchronous ${failure} post failure stops the disposable audio worker once`,()=>{
  const original=globalThis.Worker;globalThis.Worker=FakeWorker as unknown as typeof Worker;FakeWorker.failType=failure;
  const {media,closed}=source();const stop=attachCachedContainerAudio(media,async()=>undefined);
  try{media.requestCachedAudio!(4,3);const current=FakeWorker.instances.at(-1)!;assert.equal(current.terminated,1);assert.equal(current.onmessage,null);stop();assert.equal(current.terminated,1);assert.equal(closed(),0);}
  finally{stop();FakeWorker.failType=undefined;globalThis.Worker=original;}
});

test('cache misses retain reverse reply semantics and accepted byte copies really transfer',async()=>{
  const original=globalThis.Worker;globalThis.Worker=FakeWorker as unknown as typeof Worker;
  const {media,closed}=source();let reject=true;const bytes=new Uint8Array([8,9]);
  const stop=attachCachedContainerAudio(media,()=>{if(reject)throw Error('cache miss');return Promise.resolve(bytes);},undefined,async()=>{throw Error('window miss');});
  try{
    media.requestCachedAudio!(100,9);const current=FakeWorker.instances.at(-1)!;
    assert.equal(current.messages[1].ptsUs,1000,'source timestamps preserve the existing offset');
    current.onmessage!({data:{type:'peek',id:1,offset:0,length:2}});current.onmessage!({data:{type:'windows',id:2}});await settle();
    assert.deepEqual(current.messages.find(m=>m.id===1),{type:'bytes',id:1,bytes:undefined});assert.deepEqual(current.messages.find(m=>m.id===2),{type:'windows',id:2,ranges:[]});assert.equal(current.terminated,0);
    reject=false;current.onmessage!({data:{type:'peek',id:3,offset:0,length:2}});await settle();
    assert.equal(bytes.byteLength,0,'accepted copy changes ownership using actual structuredClone transfer');assert.deepEqual([...current.messages.find(m=>m.id===3).bytes],[8,9]);assert.equal(closed(),0);
  }finally{stop();globalThis.Worker=original;}
});

test('disable and recovery discard old requests and old failure events without touching the replacement',async()=>{
  const original=globalThis.Worker;globalThis.Worker=FakeWorker as unknown as typeof Worker;
  const {media,closed}=source();let release!:(value:any)=>void;const gate=new Promise<any>(resolve=>{release=resolve;});
  let delivered=0;media.onCachedAudio=()=>{delivered++;};const stop=attachCachedContainerAudio(media,()=>gate);
  try{
    media.requestCachedAudio!(1,1);const old=FakeWorker.instances.at(-1)!,onError=old.onerror!,onMessage=old.onmessage!;
    onMessage({data:{type:'peek',id:8,offset:0,length:2}});media.setCachedAudioEnabled!(false);assert.equal(old.terminated,1);
    media.setCachedAudioEnabled!(true);media.requestCachedAudio!(2,2);const current=FakeWorker.instances.at(-1)!;assert.notEqual(current,old);
    onError();onMessage({data:{type:'audio',generation:1,batch:{packets:[]}}});release(new Uint8Array([1,2]));await settle();
    assert.equal(current.terminated,0);assert.equal(current.messages.length,2);assert.equal(delivered,0);assert.equal(closed(),0);
    current.onmessage!({data:{type:'audio',generation:2,batch:{packets:[]}}});assert.equal(delivered,1);
    current.onerror!();assert.equal(current.terminated,1);stop();assert.equal(current.terminated,1);
  }finally{stop();globalThis.Worker=original;}
});
