import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareYuvFrame } from '../src/yuv-frame.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import type { DecodedFrame } from '../src/media.ts';

test('native YUV copy owns bytes, budgets both resources, and keeps timings out of metadata',async()=>{
  let clonesClosed=0,samplesClosed=0;
  const data=new Uint8Array([16,235,16,235,128,128]);
  const resource={codedWidth:2,codedHeight:2,allocationSize:()=>6,copyTo:async(out:Uint8Array)=>{out.set(data);return [{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}];},close(){clonesClosed++;}};
  const frame={kind:'video-sample',byteSize:6,width:2,height:2,description:rgbaDescription(2,2,{format:'I420',byteLength:6,stride:null}),sample:{toVideoFrame:()=>resource},close(){samplesClosed++;}} as unknown as DecodedFrame;
  const actual=await prepareYuvFrame(frame,undefined,true);
  assert.equal(actual.kind,'yuv');assert.equal(actual.byteSize,12);assert.equal(clonesClosed,1);assert.equal(samplesClosed,0);
  assert.equal(Object.hasOwn(actual.description,'copyMs'),false);assert.ok(actual.copyMs!>=0);
  data.fill(0);assert.equal(actual.pixels![0],16);actual.close();assert.equal(samplesClosed,1);
});
test('opaque and rejected native copies retain browser resources; other failures close ownership',async()=>{
  let closed=0,copied=0;
  const resource={codedWidth:2,codedHeight:2,allocationSize:()=>6,copyTo:async()=>{copied++;throw new DOMException('opaque','NotSupportedError');},close(){}};
  const frame={kind:'video-sample',byteSize:6,description:rgbaDescription(2,2,{format:null}),sample:{toVideoFrame:()=>resource},close(){closed++;}} as unknown as DecodedFrame;
  assert.equal((await prepareYuvFrame(frame)).description.colorFallback,'opaque-resource');assert.equal(copied,0);
  frame.description.format='I420';assert.equal((await prepareYuvFrame(frame)).description.colorFallback,'copyTo-not-supported');assert.equal(closed,0);
  resource.copyTo=async()=>{throw new Error('device failure');};await assert.rejects(prepareYuvFrame(frame),/device failure/);assert.equal(closed,1);
});

test('normal native copies release the decoder sample before queuing and recycle only closed buffers',async()=>{
  const {createYuvBufferPool}=await import('../src/yuv-frame.ts');
  const pool=createYuvBufferPool();let closed=0;
  const make=()=>({kind:'video-sample',byteSize:6,width:2,height:2,description:rgbaDescription(2,2,{format:'I420',byteLength:6,stride:null}),sample:{rotation:90,toVideoFrame:()=>({codedWidth:2,codedHeight:2,allocationSize:()=>6,copyTo:async(out:Uint8Array)=>{out.set([16,235,16,235,128,128]);return [{offset:0,stride:2},{offset:4,stride:1},{offset:5,stride:1}];},close(){}})},close(){closed++;}} as unknown as DecodedFrame);
  const a=await prepareYuvFrame(make(),pool);const b=await prepareYuvFrame(make(),pool);
  assert.equal(closed,2);assert.equal(a.sample,undefined);assert.equal(a.rotation,90);assert.equal(a.byteSize,6);
  assert.notEqual(a.pixels!.buffer,b.pixels!.buffer);a.close();
  const c=await prepareYuvFrame(make(),pool);assert.equal(c.pixels!.buffer,a.pixels!.buffer);
  pool.dispose();b.close();c.close();assert.equal(closed,3);
});
