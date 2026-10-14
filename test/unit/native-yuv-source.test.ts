import { yuvFixture } from '../helpers/yuv-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeYuvSource,verifyNativeWitness} from '../../src/native-yuv-source.ts';
import {yuvToRgba} from '../../src/yuv-color.ts';
import {rgbaDescription} from '../../src/frame-description.ts';
import type {DecodedFrame,MediaSource} from '../../src/media.ts';

const color={matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false};
function raw(semiplanar=false):DecodedFrame{
 const pixels=new Uint8ClampedArray([10,20,30,40,100,120]);
 return {ptsUs:0,sourcePtsUs:0,durationUs:1,width:2,height:2,byteSize:6,kind:'yuv',pixels,close(){},description:rgbaDescription(2,2,{format:semiplanar?'NV12':'YUV',byteLength:6,color,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar,chromaLocation:1,planes:semiplanar?[{offset:0,stride:2,width:2,height:2},{offset:4,stride:2,width:1,height:1}]:[{offset:0,stride:2,width:2,height:2},{offset:4,stride:1,width:1,height:1},{offset:5,stride:1,width:1,height:1}]}})};
}
function geometryFrame(codedWidth:number,codedHeight:number,visibleWidth:number,visibleHeight:number):DecodedFrame{
 const chromaWidth=Math.ceil(codedWidth/2),chromaHeight=Math.ceil(codedHeight/2),lumaBytes=codedWidth*codedHeight,chromaBytes=chromaWidth*chromaHeight;
 const pixels=new Uint8ClampedArray(lumaBytes+chromaBytes*2);
 const description=rgbaDescription(visibleWidth,visibleHeight,{codedWidth,codedHeight,visibleRect:{x:0,y:0,width:visibleWidth,height:visibleHeight},
  stride:null,format:'YUV',byteLength:pixels.byteLength,color,yuv:{bitDepth:8,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,chromaLocation:1,
   planes:[{offset:0,stride:codedWidth,width:codedWidth,height:codedHeight},
    {offset:lumaBytes,stride:chromaWidth,width:chromaWidth,height:chromaHeight},
    {offset:lumaBytes+chromaBytes,stride:chromaWidth,width:chromaWidth,height:chromaHeight}]}});
 return {ptsUs:0,sourcePtsUs:0,durationUs:1,width:visibleWidth,height:visibleHeight,byteSize:pixels.byteLength,kind:'yuv',pixels,description,close(){}};
}
test('native witness compares every YUV component independent of packing, and rejects content or color differences',()=>{
 const a=raw(true),b=raw();verifyNativeWitness(a,b);
 a.pixels![5]++;assert.throws(()=>verifyNativeWitness(a,b),/核对/);a.pixels![5]--;
 a.description.color={...color,fullRange:true};assert.throws(()=>verifyNativeWitness(a,b),/核对/);
});
test('native witness accepts coded padding when the visible rectangle and visible planes match',()=>{
 const native=geometryFrame(544,960,540,960),reference=geometryFrame(540,960,540,960);
 const nativeY=native.description.yuv!.planes[0],nativeU=native.description.yuv!.planes[1],nativeV=native.description.yuv!.planes[2];
 for(let row=0;row<960;row++)for(let col=540;col<544;col++)native.pixels![nativeY.offset+row*nativeY.stride+col]=99;
 for(let row=0;row<480;row++){
  native.pixels![nativeU.offset+row*nativeU.stride+271]=77;
  native.pixels![nativeV.offset+row*nativeV.stride+271]=88;
 }
 verifyNativeWitness(native,reference);
 native.pixels![nativeY.offset+959*nativeY.stride+539]++;
 assert.throws(()=>verifyNativeWitness(native,reference),/可见样本不一致/);
 native.pixels![nativeY.offset+959*nativeY.stride+539]--;
 native.pixels![nativeU.offset+479*nativeU.stride+270]=77;
 verifyNativeWitness(native,reference);
 assert.deepEqual(yuvToRgba(native.description,native.pixels!),yuvToRgba(reference.description,reference.pixels!));
 native.pixels![nativeU.offset+479*nativeU.stride+269]=77;
 assert.throws(()=>verifyNativeWitness(native,reference),/可见样本不一致/);
 const cropped=geometryFrame(544,960,539,960);
 assert.throws(()=>verifyNativeWitness(cropped,reference),/裁剪区域不一致/);
});
test('native pipeline preserves order under out-of-order copies and drains cancellation',async()=>{
 const original=globalThis.Worker;let active=0,peak=0,terminated=0,closed=0;
 class FakeWorker{
  onmessage?: (e:{data:unknown})=>void;onerror?:()=>void;timer?:ReturnType<typeof setTimeout>;
  postMessage({id,frame}:{id:number;frame:{pts:number;close():void}}){active++;peak=Math.max(peak,active);this.timer=setTimeout(()=>{active--;frame.close();this.onmessage?.({data:{id,buffer:new ArrayBuffer(6),layout:[{offset:0,stride:2},{offset:4,stride:2}]}});},frame.pts%2?1:10);}
  terminate(){terminated++;clearTimeout(this.timer);}
 }
 globalThis.Worker=FakeWorker as unknown as typeof Worker;
 function frame(pts:number):DecodedFrame{return {...raw(true),ptsUs:pts,sourcePtsUs:pts,kind:'video-sample',sample:{rotation:0,toVideoFrame:()=>({pts,close(){}})} as unknown as DecodedFrame['sample'],close(){closed++;}};}
 const capability={hasSize:true,hasDts:true};
 const source={info:{},async getBitstreamIndex(){assert.equal(this,source);return {packets:128,complete:false};},getAnalysisCapability(){assert.equal(this,source);return capability;},frameAt:async(pts:number)=>frame(pts),async *framesFrom(){for(let i=0;i<9;i++)yield frame(i);},dispose(){}} as unknown as MediaSource;
 const wrapped=nativeYuvSource(source,2,1);
 try{
  assert.equal(wrapped.getAnalysisCapability?.(),capability,'readback wrapper retains packet analysis and its receiver');
  assert.deepEqual(await wrapped.getBitstreamIndex?.(),{packets:128,complete:false});
  const pts=[];for await(const f of wrapped.framesFrom(0)){pts.push(f.ptsUs);assert.equal(f.description.yuv?.chromaLocation,1);f.close();}
  assert.deepEqual(pts,[0,1,2,3,4,5,6,7,8]);assert.equal(peak,2);
  const iterator=wrapped.framesFrom(0);const first=await iterator.next();first.value!.close();await iterator.return(undefined);assert.equal(active,0);
  const pending=wrapped.frameAt(0);wrapped.dispose();await assert.rejects(pending,/释放/);assert.equal(terminated,2);assert.ok(closed>=12);
 }finally{wrapped.dispose();globalThis.Worker=original;}
});

test('witness rejects visible chroma changes for odd crops, both crop edges',()=>{
 for(const location of [1,2,3,4,5,6]){
  const native=geometryFrame(8,8,5,3),reference=geometryFrame(6,4,5,3);
  for(const f of [native,reference]){f.description.visibleRect.x=1;f.description.visibleRect.y=1;f.description.yuv!.chromaLocation=location;}
  const l=native.description.yuv!;
  // Change every padding cell while retaining the intersecting 3x2 crop.
  for(const p of l.planes.slice(1))for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(x>=3||y>=2)native.pixels![p.offset+y*p.stride+x]=255;
  verifyNativeWitness(native,reference);
  for(const p of l.planes.slice(1))for(const [x,y] of [[0,0],[2,1]]){
   const at=p.offset+y*p.stride+x;native.pixels![at]=1;
   assert.throws(()=>verifyNativeWitness(native,reference),/可见样本/);native.pixels![at]=0;
  }
  assert.deepEqual(yuvToRgba(native.description,native.pixels!),yuvToRgba(reference.description,reference.pixels!));
 }
});


test('HDR native witness accepts exact 10/12-bit BT.2100 planes and rejects precision loss',()=>{
 for(const depth of [10,12])for(const transfer of ['pq','hlg']) {
  const frames=[yuvFixture(depth,false,false,'bt2020-ncl',4,2),yuvFixture(depth,true,false,'bt2020-ncl',4,2)].map(f=>{
    f.description.color.transfer=transfer;
    return {...f,ptsUs:0,sourcePtsUs:0,durationUs:1,width:4,height:2,byteSize:f.pixels.byteLength,kind:'yuv' as const,close(){}};
  });
  verifyNativeWitness(frames[0],frames[1]);
  frames[1].pixels[0]^=1;assert.throws(()=>verifyNativeWitness(frames[0],frames[1]),/核对/);frames[1].pixels[0]^=1;
  frames[1].description.yuv!.bitDepth=8;assert.throws(()=>verifyNativeWitness(frames[0],frames[1]),/核对/);
 }
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function converterFixture(t: import('node:test').TestContext, depth=1, ownsSource=true) {
 const original=globalThis.Worker, workers:FakeWorker[]=[], samples:Array<{closed:number;senderClosed:number;receiverClosed:number}>=[];
 let disposed=0, calls=0, throwPost=false, throwDispose=false;
 class FakeWorker {
  onmessage:((event:{data:any})=>void)|null=null; onerror:(()=>void)|null=null; onmessageerror:(()=>void)|null=null;
  requests:Array<{id:number;buffer?:ArrayBuffer;frame:{record:typeof samples[number];close():void}}> = []; terminated=0;
  constructor(){workers.push(this);}
  postMessage(request:any){if(throwPost)throw new Error('injected post failure');this.requests.push({...request,buffer:request.buffer?structuredClone(request.buffer,{transfer:[request.buffer]}):undefined});}
  reply(request=this.requests.at(-1)!,value=10,error?:string){if(!request.frame.record.receiverClosed)request.frame.record.receiverClosed++;this.onmessage?.({data:{id:request.id,...(error?{error}:{buffer:new Uint8Array([value,20,30,40,100,120]).buffer,layout:[{offset:0,stride:2},{offset:4,stride:2}]})}});}
  terminate(){this.terminated++;for(const r of this.requests)if(!r.frame.record.receiverClosed)r.frame.record.receiverClosed++;}
 }
 globalThis.Worker=FakeWorker as unknown as typeof Worker;
 function frame(pts:number):DecodedFrame {
  const record={closed:0,senderClosed:0,receiverClosed:0};samples.push(record);
  return {...raw(true),ptsUs:pts,sourcePtsUs:pts,kind:'video-sample',sample:{rotation:0,toVideoFrame:()=>({record,close(){record.senderClosed++;}})} as unknown as DecodedFrame['sample'],close(){record.closed++;}};
 }
 const source={info:{},frameAt:async(pts:number)=>{calls++;return frame(pts);},async *framesFrom(){yield frame(0);},dispose(){disposed++;if(throwDispose)throw new Error('injected source dispose failure');}} as unknown as MediaSource;
 const wrapped=nativeYuvSource(source,depth,1,ownsSource);
 t.after(()=>{throwDispose=false;wrapped.dispose();globalThis.Worker=original;});
 return {wrapped,workers,samples,source,frame,get disposed(){return disposed;},get calls(){return calls;},set throwPost(v:boolean){throwPost=v;},set throwDispose(v:boolean){throwDispose=v;}};
}

for(const event of ['onerror','onmessageerror'] as const) test(`converter ${event} rejects its pool and slot waiters without disposing the upstream source`,async t=>{
 const f=converterFixture(t,2);const errors:unknown[]=[];
 const requests=[0,1,2].map(pts=>f.wrapped.frameAt(pts).then(frame=>{frame.close();return null;},error=>{errors.push(error);return error;}));
 await tick();f.workers[0][event]?.();await tick();
 assert.equal(errors.length,3,'all in-flight jobs and queued slot acquisitions settle');
 assert.ok(errors.every(error=>error===errors[0]));assert.equal(f.disposed,0,'conversion transport failure does not dispose the independently owned upstream source');
 assert.ok(f.workers.every(worker=>worker.terminated===1));
 await assert.rejects(f.wrapped.frameAt(3),/Worker/);assert.equal(f.calls,3,'latched failure cannot dispatch another source request');
 await Promise.all(requests);
});

test('converter post failure closes the original sample once and closes only its untransferred native resource',async t=>{
 const f=converterFixture(t);f.throwPost=true;await assert.rejects(f.wrapped.frameAt(0),/post failure|Worker/);
 assert.equal(f.samples[0].closed,1);assert.equal(f.samples[0].senderClosed,1);assert.equal(f.samples[0].receiverClosed,0);
 assert.equal(f.workers[0].terminated,1);
});

test('converter per-picture copy failure closes its sample once and keeps the worker usable',async t=>{
 const f=converterFixture(t);const pending=f.wrapped.frameAt(0);const rejected=assert.rejects(pending,/copy failed/);await tick();f.workers[0].reply(undefined,10,'copy failed');await rejected;
 assert.equal(f.samples[0].closed,1);assert.equal(f.samples[0].senderClosed,0,'successful post transfers native resource ownership');
 assert.equal(f.workers[0].terminated,0);const next=f.wrapped.frameAt(1);await tick();f.workers[0].reply();(await next).close();
});

test('converter ignores an old reply after the slot is reused',async t=>{
 const f=converterFixture(t);const first=f.wrapped.frameAt(0);await tick();const old=f.workers[0].requests[0];f.workers[0].reply(old);(await first).close();
 let settled=false;const second=f.wrapped.frameAt(1).then(frame=>{settled=true;return frame;});await tick();
 f.workers[0].reply(old,200);await tick();assert.equal(settled,false,'a late reply cannot fulfill the next job');
 f.workers[0].reply(undefined,50);const frame=await second;assert.equal(frame.pixels![0],50);frame.close();
});

test('converter dispose settles a held upstream read and releases its late sample once',async t=>{
 const f=converterFixture(t);let finish!:(frame:DecodedFrame)=>void;f.source.frameAt=()=>new Promise(resolve=>finish=resolve);
 // Bind a fresh wrapper after replacing the upstream method.
 const wrapped=nativeYuvSource(f.source,1,1,false);let rejected=false;
 const pending=wrapped.frameAt(0).catch(error=>{rejected=true;return error;});wrapped.dispose();await tick();
 try{assert.equal(rejected,true,'dispose must not wait for upstream to return');}
 finally{finish(f.frame(0));await pending;wrapped.dispose();}
 assert.equal(f.samples.at(-1)!.closed,1);assert.equal(f.disposed,0);
});

test('throwing source disposal cannot skip converter pending/handler/worker cleanup',async t=>{
 const f=converterFixture(t);const pending=f.wrapped.frameAt(0);let rejected=false;pending.catch(()=>{rejected=true;});await tick();f.throwDispose=true;
 assert.throws(()=>f.wrapped.dispose(),/source dispose failure/);await tick();assert.equal(rejected,true);
 assert.equal(f.workers[0].terminated,1);assert.equal(f.workers[0].onmessage,null);assert.equal(f.workers[0].onerror,null);assert.equal(f.workers[0].onmessageerror,null);
});

test('converter returns a caller-owned buffer only after close and transfers the recycled buffer',async t=>{
 const f=converterFixture(t);const first=f.wrapped.frameAt(0);await tick();f.workers[0].reply();const frame=await first;const pixels=frame.pixels!;
 assert.equal(pixels.byteLength,6);frame.close();frame.close();
 const second=f.wrapped.frameAt(1);await tick();assert.equal(pixels.byteLength,0,'the returned buffer is transferred only after caller close');
 assert.equal(f.workers[0].requests[1].buffer!.byteLength,6);f.workers[0].reply();(await second).close();
 assert.ok(f.samples.every(sample=>sample.closed===1&&sample.senderClosed===0&&sample.receiverClosed===1));
});

test('converter failure remains isolated from a healthy wrapper using the same upstream source',async t=>{
 const f=converterFixture(t);const healthy=nativeYuvSource(f.source,1,1,false);
 try{
  const broken=f.wrapped.frameAt(0);const rejected=assert.rejects(broken,/Worker/);const good=healthy.frameAt(1);await tick();
  f.workers[0].onmessageerror?.();await rejected;f.workers[1].reply();(await good).close();assert.equal(f.disposed,0);assert.equal(f.workers[1].terminated,0);
 }finally{healthy.dispose();}
});

test('returning a converter iterator does not hang on its held next input and closes the late sample',async t=>{
 const f=converterFixture(t);let finish!:(frame:DecodedFrame)=>void;
 f.source.framesFrom=async function*(){yield f.frame(0);yield await new Promise<DecodedFrame>(resolve=>finish=resolve);};
 const wrapped=nativeYuvSource(f.source,1,1,false),iterator=wrapped.framesFrom(0);
 const first=iterator.next();await tick();f.workers[1].reply();(await first).value!.close();await tick();
 let returned=false;const returning=iterator.return(undefined).then(()=>returned=true);await tick();
 try{assert.equal(returned,true,'iterator cancellation must not wait for another upstream picture');}
 finally{finish(f.frame(1));await returning;await tick();wrapped.dispose();}
 assert.equal(f.samples.at(-1)!.closed,1);
});

test('malformed converter replies retire the transport and constructor failures clean partial pools',async t=>{
 const f=converterFixture(t);const pending=f.wrapped.frameAt(0);const rejected=assert.rejects(pending,/Worker/);await tick();f.workers[0].onmessage?.({data:{id:f.workers[0].requests[0].id,buffer:new ArrayBuffer(6),layout:'bad'}});await rejected;assert.equal(f.workers[0].terminated,1);
 let created=0,terminated=0;const old=globalThis.Worker;
 class BrokenWorker{constructor(){if(created++)throw new Error('constructor failed');}onmessage=null;onerror=null;onmessageerror=null;terminate(){terminated++;}}
 globalThis.Worker=BrokenWorker as unknown as typeof Worker;
 try{assert.throws(()=>nativeYuvSource(f.source,2),/constructor failed/);assert.equal(terminated,1);}finally{globalThis.Worker=old;}
});
