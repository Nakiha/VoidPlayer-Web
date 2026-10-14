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
  const NativeWorker=globalThis.Worker,workers=[],transfers=[],samples=[],readbacks=[];let upstreamDisposed=0,hold=false,releaseHeld;
  class TrackedWorker extends NativeWorker{
   constructor(...args){super(...args);this.terminations=0;this.timestamps=new Map();workers.push(this);this.addEventListener('message',({data})=>{if(data.buffer)readbacks.push({id:data.id,pts:this.timestamps.get(data.id),values:visible(new Uint8Array(data.buffer),data.layout)});});}
   postMessage(message,transfer){this.timestamps.set(message.id,message.frame.timestamp);super.postMessage(message,transfer);transfers.push({id:message.id,frameDetached:message.frame.codedWidth===0,recycled:message.buffer?message.buffer.byteLength===0:null});}
   terminate(){this.terminations++;super.terminate();}
  }
  globalThis.Worker=TrackedWorker;
  const color={matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false};
  // Natural source row sizes are all four-byte aligned. Custom source padding
  // has separate WebKit constructor differences, so stride/offset behavior is
  // exercised independently in the explicit padded copyTo destination below.
  const width=8,height=6,sourceLayout=[{offset:0,stride:8},{offset:48,stride:4},{offset:60,stride:4}],destinationLayout=[{offset:16,stride:12},{offset:96,stride:8},{offset:128,stride:8}];
  const sourceBytes=new Uint8Array(72),expected=[];
  for(let plane=0;plane<3;plane++)for(let y=0;y<(plane?height/2:height);y++)for(let x=0;x<(plane?width/2:width);x++){
   const value=plane===0?20+y*13+x*3:plane===1?90+y*7+x*5:150+y*9+x*4;
   sourceBytes[sourceLayout[plane].offset+y*sourceLayout[plane].stride+x]=value;expected.push(value);
  }
  const visible=(bytes,layout)=>layout.flatMap((p,plane)=>Array.from({length:plane?height/2:height},(_,y)=>[...bytes.subarray(p.offset+y*p.stride,p.offset+y*p.stride+(plane?width/2:width))]).flat());
  const create=pts=>new VideoFrame(sourceBytes.map(value=>value+Math.floor(pts/40000)%8),{format:'I420',codedWidth:width,codedHeight:height,layout:sourceLayout,timestamp:pts,colorSpace:color});
  const direct=create(0);let nativeDefault,nativePadded;
  try{
   const packed=new Uint8Array(direct.allocationSize()),packedLayout=await direct.copyTo(packed);
   nativeDefault={layout:packedLayout,values:visible(packed,packedLayout),byteLength:packed.byteLength};
   const padded=new Uint8Array(152).fill(0xee),paddedLayout=await direct.copyTo(padded,{layout:destinationLayout});
   nativePadded={layout:paddedLayout,values:visible(padded,paddedLayout),byteLength:padded.byteLength};
  }finally{direct.close();}
  // Diagnostic only for the superseded fixture: compare the raw native API
  // before blaming converter transport for a Linux-specific constructor copy.
  const legacy=new VideoFrame(new Uint8Array([10,20,30,40,100,120]),{format:'I420',codedWidth:2,codedHeight:2,timestamp:0,colorSpace:color});
  let legacyDirect;
  try{const bytes=new Uint8Array(legacy.allocationSize()),layout=await legacy.copyTo(bytes);legacyDirect={expected:[10,20,30,40,100,120],values:[...bytes],layout};}finally{legacy.close();}
  const make=pts=>{
   const frame=create(pts);
   const record={closed:0};samples.push(record);
   return {ptsUs:pts,sourcePtsUs:pts,durationUs:40000,width,height,byteSize:frame.allocationSize(),kind:'video-sample',description:rgbaDescription(width,height,{format:'I420',byteLength:frame.allocationSize(),color}),sample:{rotation:0,toVideoFrame:()=>frame.clone()},close(){record.closed++;frame.close();}};
  };
  const source={info:{},frameAt:async pts=>hold?new Promise(resolve=>releaseHeld=()=>resolve(make(pts))):make(pts),async *framesFrom(){for(let i=0;i<6;i++)yield make(i*40000);},dispose(){upstreamDisposed++;}};
  const wrapped=nativeYuvSource(source,2,1);
  try{
   const first=await wrapped.frameAt(0);const pixels=first.pixels,layout=first.description.yuv.planes;const values=visible(pixels,layout);first.close();first.close();
   for(let i=0;i<3;i++){const f=await wrapped.frameAt((i+1)*40000);f.close();}
   const order=[];for await(const f of wrapped.framesFrom(0)){order.push(f.ptsUs);f.close();if(order.length===2)break;}
   hold=true;let rejected=false;const pending=wrapped.frameAt(999999).catch(error=>{rejected=error.name==='AbortError';});
   wrapped.dispose();await pending;releaseHeld();await new Promise(resolve=>setTimeout(resolve,0));
   return {fixture:{width,height,sourceLayout,destinationLayout,expected},nativeDefault,nativePadded,legacyDirect,values,layout,readbacks,originalBufferDetached:pixels.byteLength===0,order,rejected,upstreamDisposed,sampleCloses:samples.map(s=>s.closed),transfers,terminations:workers.map(w=>w.terminations)};
  }finally{wrapped.dispose();globalThis.Worker=NativeWorker;}
 });
 // Persist the native control even on failure, so CI can distinguish source
 // packing, direct copy and converter/Worker failures from actual observations.
 await mkdir('.run/native-yuv-lifecycle',{recursive:true});await writeFile(`.run/native-yuv-lifecycle/${engine}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({event:'native-yuv-lifecycle-observation',engine,...result}));
 assert.deepEqual(result.nativeDefault.values,result.fixture.expected,'direct native copy preserves every active row/plane');
 assert.deepEqual(result.nativePadded.values,result.fixture.expected,'direct native copy respects explicit padded output strides');
 assert.deepEqual(result.nativePadded.layout,result.fixture.destinationLayout);
 assert.deepEqual(result.values,result.fixture.expected,'real Worker copy matches independently expected active bytes');assert.equal(result.originalBufferDetached,true);
 assert.ok(result.readbacks.length>=6);for(const readback of result.readbacks)assert.deepEqual(readback.values,result.fixture.expected.map(value=>value+Math.floor(readback.pts/40000)%8),`every returned Worker frame matches its actual timestamp ${readback.pts}`);
 assert.deepEqual(result.order,[0,40000]);assert.equal(result.rejected,true);assert.equal(result.upstreamDisposed,1);
 assert.ok(result.sampleCloses.every(n=>n===1));assert.ok(result.transfers.every(r=>r.frameDetached));assert.ok(result.transfers.some(r=>r.recycled));assert.deepEqual(result.terminations,[1,1]);assert.deepEqual(errors,[]);
 console.log(`PASS ${engine}: aligned multirow I420 native/default+padded controls and real Worker copy, transfer/reuse, ordered cancellation, prompt dispose and late input cleanup`);
}finally{await browser?.close();await server.close();}
