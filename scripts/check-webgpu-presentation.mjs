import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
const server=await createServer({server:{port:0,host:'127.0.0.1'}});await server.listen();
let browser;
try{
 for(const [name,engine] of Object.entries({chromium,webkit})){
  browser=await engine.launch({headless:false,...(name==='chromium'?{channel:'chrome'}:{})});
  const page=await browser.newPage();
  await page.route('**/gpu-presentation-test',r=>r.fulfill({contentType:'text/html',body:'<div class="frame-stage"><canvas id="source"></canvas></div>'}));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/gpu-presentation-test`);
  const report=await page.evaluate(async()=>{
   const {initializeGpuPresentation,keepNativeGpuResource}=await import('/src/webgpu-presenter.ts');
   const {paintFrame,captureFrame,setPresentationGeometry,disposePresentation}=await import('/src/presenter.ts');
   const {VideoSample}=await import('/node_modules/mediabunny/dist/modules/src/index.js');
   const {sampleDescription,rgbaDescription}=await import('/src/frame-description.ts');
   const source=document.querySelector('#source');await initializeGpuPresentation([source]);
   if(!keepNativeGpuResource())throw new Error('Synthetic profile detection did not enable WebGPU');
   const geometry={width:96,height:64,imageWidth:96,imageHeight:64,zoom:1,offsetX:0,offsetY:0,dpr:2};
   setPresentationGeometry(source,geometry);
   let reads=0;const original=source.getContext.bind(source);source.getContext=(...a)=>{if(a[0]==='2d')reads++;return original(...a);};
   const pixelRead=()=>{const c=captureFrame(source);return{width:c.width,height:c.height,bytes:[...c.getContext('2d').getImageData(0,0,c.width,c.height).data]};};
   // RGBA native resource exercises clone ownership, lazy synchronous capture,
   // rotation, source-sized capture independent of viewport, and paused redraw.
   const input=new OffscreenCanvas(3,2);const colors=new Uint8ClampedArray([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,255,255,0,255,255,0,255,255,255]);
   input.getContext('2d').putImageData(new ImageData(colors,3,2),0,0);
   const results=[];
   for(const rotation of [0,90,180,270]){
    const sample=new VideoSample(new VideoFrame(input,{timestamp:0}),{rotation});
    const expected=new OffscreenCanvas(rotation%180?2:3,rotation%180?3:2);sample.draw(expected.getContext('2d'),0,0,expected.width,expected.height);
    paintFrame(source,{kind:'video-sample',description:sampleDescription(sample),sample,width:sample.displayWidth,height:sample.displayHeight});sample.close();
    const eager=reads;const got=pixelRead(),reference=[...expected.getContext('2d').getImageData(0,0,expected.width,expected.height).data];
    setPresentationGeometry(source,{...geometry,zoom:3,offsetX:13,offsetY:-9});const moved=pixelRead();
    results.push({rotation,eager,got,reference,moved});
   }
   const depths=[];
   // Endpoint patches detect loss of high bits, shifted P010 interpretation,
   // odd-size plane addressing, and premature recycling of WASM output.
   for(const depth of [8,10,12,16])for(const shift of (depth===10?[0,6]:[0]))for(const semi of [false,true]){
    const w=5,h=3,b=depth===8?1:2,scale=2**(depth-8);let length=0;
    const planes=Array.from({length:semi?2:3},(_,i)=>{const width=i?3:w,height=i?2:h,stride=width*b*(i&&semi?2:1);const p={offset:length,stride,width,height};length+=stride*height;return p;});
    const pixels=new Uint8ClampedArray(length),view=new DataView(pixels.buffer);
    planes.forEach((p,i)=>{for(let y=0;y<p.height;y++)for(let x=0;x<p.stride/b;x++){const code=(i?128*scale:(x%2?235:16)*scale)*2**shift;const pos=p.offset+y*p.stride+x*b;if(b===1)pixels[pos]=code;else view.setUint16(pos,code,true);}});
    const d={revision:1,width:w,height:h,codedWidth:w,codedHeight:h,visibleRect:{x:0,y:0,width:w,height:h},displayWidth:w,displayHeight:h,stride:null,byteLength:length,format:'YUV',color:{matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false},yuv:{bitDepth:depth,bitShift:shift,subsampleX:1,subsampleY:1,semiplanar:semi,planes}};
    paintFrame(source,{kind:'yuv',description:d,pixels,width:w,height:h});pixels.fill(0);
    const got=pixelRead();depths.push({depth,shift,semi,black:got.bytes.slice(0,3),white:got.bytes.slice(4,7),width:got.width,height:got.height});
   }
   const executor=source.dataset.colorExecutor;
   paintFrame(source,{kind:'rgba8',description:rgbaDescription(3,2),pixels:colors,width:3,height:2});
   const fallback={executor:source.dataset.colorExecutor,pixels:pixelRead()};
   setPresentationGeometry(source,null);setPresentationGeometry(source,geometry);
   const resumed=new VideoSample(new VideoFrame(input,{timestamp:0}));
   paintFrame(source,{kind:'video-sample',description:sampleDescription(resumed),sample:resumed,width:3,height:2});resumed.close();
   const resumedExecutor=source.dataset.colorExecutor;disposePresentation();
   return{results,depths,executor,fallback,resumedExecutor,remaining:document.querySelectorAll('.frame-presentation').length};
  });
  assert.equal(report.executor,'webgpu-yuv');assert.equal(report.remaining,0);assert.equal(report.fallback.executor,'rgba-upload');assert.deepEqual(report.fallback.pixels.bytes,report.results[0].reference);assert.equal(report.resumedExecutor,'webgpu-external');
  for(const [i,r]of report.results.entries()){
   if(!i)assert.equal(r.eager,0,'native playback must not touch source 2D canvas');
   assert.deepEqual(r.got.bytes,r.reference,`${name} rotation ${r.rotation}`);assert.deepEqual(r.moved,r.got,'paused capture must not change with viewport');
  }
  for(const c of report.depths){assert.equal(c.width,5);assert.equal(c.height,3);assert.ok(c.black.every(v=>v<=1),JSON.stringify(c));assert.ok(c.white.every(v=>v>=254),JSON.stringify(c));}
  console.log(`PASS ${name}: automatic resource profile, clone ownership, sync capture, four rotations, paused zoom, ${report.depths.length} high-depth/shift/layout cases, RGBA fallback/re-entry, cleanup`);
  await browser.close();browser=undefined;
 }
}finally{await browser?.close();await server.close();}
