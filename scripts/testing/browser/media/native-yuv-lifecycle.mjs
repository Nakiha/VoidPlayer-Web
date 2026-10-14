import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
const engine=process.argv[2]??'chromium';
assert.ok(['chromium','webkit'].includes(engine));
const server=await createServer({server:{port:0,host:'127.0.0.1'}});let browser;
try{
 await server.listen();browser=await ({chromium,webkit}[engine]).launch({headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/native-yuv-lifecycle',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Native readback lifecycle</title>'}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/native-yuv-lifecycle`);
 const result=await page.evaluate(async()=>{
  const {nativeYuvSource}=await import('/src/native-yuv-source.ts');
  const {rgbaDescription}=await import('/src/frame-description.ts');
  const NativeWorker=globalThis.Worker,workers=[],transfers=[],samples=[];let upstreamDisposed=0,hold=false,releaseHeld;
  class TrackedWorker extends NativeWorker{
   constructor(...args){super(...args);this.terminations=0;workers.push(this);}
   postMessage(message,transfer){super.postMessage(message,transfer);transfers.push({id:message.id,frameDetached:message.frame.codedWidth===0,recycled:message.buffer?message.buffer.byteLength===0:null});}
   terminate(){this.terminations++;super.terminate();}
  }
  globalThis.Worker=TrackedWorker;
  const color={matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false};
  const make=pts=>{
   const frame=new VideoFrame(new Uint8Array([10,20,30,40,100,120]),{format:'I420',codedWidth:2,codedHeight:2,timestamp:pts,colorSpace:color});
   const record={closed:0};samples.push(record);
   return {ptsUs:pts,sourcePtsUs:pts,durationUs:40000,width:2,height:2,byteSize:6,kind:'video-sample',description:rgbaDescription(2,2,{format:'I420',color}),sample:{rotation:0,toVideoFrame:()=>frame.clone()},close(){record.closed++;frame.close();}};
  };
  const source={info:{},frameAt:async pts=>hold?new Promise(resolve=>releaseHeld=()=>resolve(make(pts))):make(pts),async *framesFrom(){for(let i=0;i<6;i++)yield make(i*40000);},dispose(){upstreamDisposed++;}};
  const wrapped=nativeYuvSource(source,2,1);
  try{
   const first=await wrapped.frameAt(0);const pixels=first.pixels;const values=[...pixels];first.close();first.close();
   for(let i=0;i<3;i++){const f=await wrapped.frameAt((i+1)*40000);f.close();}
   const order=[];for await(const f of wrapped.framesFrom(0)){order.push(f.ptsUs);f.close();if(order.length===2)break;}
   hold=true;let rejected=false;const pending=wrapped.frameAt(999999).catch(error=>{rejected=error.name==='AbortError';});
   wrapped.dispose();await pending;releaseHeld();await new Promise(resolve=>setTimeout(resolve,0));
   return {values,originalBufferDetached:pixels.byteLength===0,order,rejected,upstreamDisposed,sampleCloses:samples.map(s=>s.closed),transfers,terminations:workers.map(w=>w.terminations)};
  }finally{wrapped.dispose();globalThis.Worker=NativeWorker;}
 });
 assert.deepEqual(result.values,[10,20,30,40,100,120]);assert.equal(result.originalBufferDetached,true);
 assert.deepEqual(result.order,[0,40000]);assert.equal(result.rejected,true);assert.equal(result.upstreamDisposed,1);
 assert.ok(result.sampleCloses.every(n=>n===1));assert.ok(result.transfers.every(r=>r.frameDetached));assert.ok(result.transfers.some(r=>r.recycled));assert.deepEqual(result.terminations,[1,1]);assert.deepEqual(errors,[]);
 await mkdir('.run/native-yuv-lifecycle',{recursive:true});await writeFile(`.run/native-yuv-lifecycle/${engine}.json`,JSON.stringify(result,null,2));
 console.log(`PASS ${engine}: real VideoFrame/Worker planar copy, transfer/reuse, ordered cancellation, prompt dispose and late input cleanup`);
}finally{await browser?.close();await server.close();}
