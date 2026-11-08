import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from './testing/browser-engines.mjs';
const server = await createServer({server:{port:0,host:'127.0.0.1'}});
await server.listen();
let browser;
try {
  const targets=process.argv.slice(2);
  if(!targets.length)targets.push('chromium',...(process.platform==='darwin'?['webkit']:[]));
  for (const name of targets) {
    const engine={chromium,webkit}[name];if(!engine)throw Error(`Unknown browser: ${name}`);
    browser = await engine.launch({headless:true});
    const page = await browser.newPage({locale:'zh-CN'}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/presentation-test',route=>route.fulfill({contentType:'text/html',body:'<div class="frame-stage"><canvas id="source"></canvas></div>'}));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/presentation-test`);
    const result = await page.evaluate(async () => {
      const gpu=await import('/src/presentation/webgpu-presenter.ts');
      const {paintFrame,captureFrame,setPresentationGeometry,disposePresentation,redrawPresentationChannel}=await import('/src/presentation/presenter.ts');
      const {setPresentationChannel}=await import('/src/presentation/presentation-channel.ts');
      const {setColorMode}=await import('/src/media/policy/color-mode.ts');setColorMode('reference');
      const {rgbaDescription}=await import('/shared/media/frame-description.ts');
      const {sampleDescription}=await import('/src/media/decoding/frame-resource.ts');
      const {VideoSample}=await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const {yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
      const {yuvToRgba}=await import('/shared/color/yuv-color.ts');
      const source=document.getElementById('source'), geometry={width:13,height:11,imageWidth:5,imageHeight:3,zoom:1,offsetX:1.2,offsetY:-.4,dpr:2};
      let sourceDraws=0,glContexts=0,denyContext=false;
      const getContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){
        if(type==='webgpu'&&denyContext)return null;
        if(type.startsWith('webgl')){glContexts++;throw Error('Removed WebGL path was used');}
        if(this===source&&type==='2d')sourceDraws++;
        return getContext.call(this,type,...args);
      };
      await gpu.initializeGpuPresentation([source]);
      setPresentationGeometry(source,geometry);
      const read=()=>[...captureFrame(source).getContext('2d').getImageData(0,0,source.width,source.height).data];
      const delta=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
      const settleGpu=async label=>{await gpu.gpuDrain(source);await new Promise(r=>setTimeout(r,0));if(source.dataset.colorOutputReason==='webgpu-resource-error')throw Error(`GPU resource error after ${label}`);};
      const cases=[];
      for(const depth of [8,10,12,16])for(const semi of [false,true])for(const full of [false,true])for(const matrix of ['bt709','smpte170m','bt2020-ncl']){
        const f=yuvFixture(depth,semi,full,matrix),frame={kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3};
        paintFrame(source,frame);cases.push({depth,semi,full,matrix,max:delta(read(),yuvToRgba(f.description,f.pixels))});
      }
      for(const transfer of ['pq','hlg','smpte2084','arib-std-b67'])for(const depth of [10,12,16])for(const semi of [false,true]){
        const f=yuvFixture(depth,semi,false,'bt2020-ncl');f.description.color.transfer=transfer;
        paintFrame(source,{kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3});
        cases.push({transfer,depth,semi,max:delta(read(),yuvToRgba(f.description,f.pixels))});
      }
      await settleGpu('YUV');
      const f=yuvFixture(10,true,false,'bt709',5,3,6);
      f.description.visibleRect={x:1,y:1,width:3,height:1};f.description.width=3;f.description.height=1;
      const reference=yuvToRgba(f.description,f.pixels);
      for(const rotation of [0,90,180,270]){
        paintFrame(source,{kind:'yuv',description:f.description,pixels:f.pixels,width:3,height:1,rotation});
        const expected=[];for(const index of rotation===180||rotation===270?[2,1,0]:[0,1,2])expected.push(...reference.slice(index*4,index*4+4));
        cases.push({rotation,max:delta(read(),expected)});
      }
      await settleGpu('crop rotations');
      const shared=await import('/src/media/decoding/pixel-frame.ts');let recycled=0;
      const owned=yuvFixture(),expected=yuvToRgba(owned.description,owned.pixels);
      const frame=shared.sharePixelFrame({kind:'yuv',description:owned.description,pixels:owned.pixels,width:5,height:3,close(){recycled++;owned.pixels.fill(0);}});
      paintFrame(source,frame);frame.close();if(recycled)throw Error('Retained pixels released early');
      cases.push({ownership:true,max:delta(read(),expected)});
      const commit=frame.presentedCommit;
      for(const channel of ['y','u','v','rgb']){
        setPresentationChannel(channel);redrawPresentationChannel();
        cases.push({channel,max:delta(read(),yuvToRgba(owned.description,owned.pixels,channel))});
        if(frame.presentedCommit!==commit)throw Error('Channel redraw changed frame identity');
      }
      await settleGpu('retained channels');
      const eager=sourceDraws;
      const colors=new Uint8ClampedArray([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
      const rgba=pixels=>({kind:'rgba8',description:rgbaDescription(2,2),pixels,width:2,height:2});
      paintFrame(source,rgba(colors));const rgbaPixels=read();
      if(recycled!==1)throw Error('Replaced frame lease was not released');
      await settleGpu('RGBA');
      const input=new OffscreenCanvas(2,2);input.getContext('2d').putImageData(new ImageData(colors,2,2),0,0);
      const native=[];
      for(const rotation of [0,90,180,270]){
        const sample=new VideoSample(new VideoFrame(input,{timestamp:0}),{rotation}),target=new OffscreenCanvas(2,2);
        sample.draw(target.getContext('2d'),0,0,2,2);
        const before=sourceDraws;paintFrame(source,{kind:'video-sample',description:sampleDescription(sample),sample,width:2,height:2});sample.close();
        if(sourceDraws!==before)throw Error('Playback drew the source canvas');
        native.push({rotation,max:delta(read(),target.getContext('2d').getImageData(0,0,2,2).data)});await settleGpu(`native rotation ${rotation}`);
      }
      const hdr=[];
      for(const transfer of ['pq','hlg']){
        const sample=new VideoSample(new VideoFrame(new Uint8Array([40,90,140,190,128,128]),{format:'I420',codedWidth:2,codedHeight:2,timestamp:0,colorSpace:{primaries:'bt2020',transfer,matrix:'bt2020-ncl',fullRange:false}}));
        const target=new OffscreenCanvas(2,2);sample.draw(target.getContext('2d'),0,0,2,2);
        const frame={kind:'video-sample',description:sampleDescription(sample),sample,width:2,height:2};
        paintFrame(source,frame);const first=read();paintFrame(source,frame);
        hdr.push({transfer,executor:source.dataset.colorExecutor,max:delta(first,target.getContext('2d').getImageData(0,0,2,2).data),repeat:delta(read(),first)});sample.close();await settleGpu(`HDR ${transfer}`);
      }
      for(const size of [2,4096]){
        const pixels=new Uint8ClampedArray(size*4);
        for(let x=0;x<size;x++)pixels.set(x%2?[0,0,255,255]:[255,0,0,255],x*4);
        setPresentationGeometry(source,{width:80,height:20,imageWidth:80,imageHeight:20,zoom:1,offsetX:0,offsetY:0,dpr:2});
        paintFrame(source,{kind:'rgba8',description:rgbaDescription(size,1),pixels,width:size,height:1});
        const viewport=await gpu.gpuCaptureViewport(source);
        for(const x of [37,84,129]){
          const pixel=viewport.slice((20*160+x)*4,(20*160+x)*4+4),u=(x+.5)/160,sample=Math.max(0,Math.min(size-1,u*size-.5));
          const fraction=sample-Math.floor(sample),red=Math.floor(sample)%2?fraction:1-fraction;
          const expected=size===2?(Math.floor(u*size)%2?0:255):Math.round(red*255);
          cases.push({sampling:size,x,pixel:[...pixel],expected,max:Math.abs(pixel[0]-expected)});
        }
      }
      setPresentationGeometry(source,geometry);
      paintFrame(source,{kind:'rgba8',description:rgbaDescription(1,1),width:1,height:1,pixels:new Uint8ClampedArray([255,0,0,128])});
      const alpha=read();await Promise.resolve();
      const surface=document.querySelector('.frame-presentation'),mix=new OffscreenCanvas(surface.width,surface.height),ctx=mix.getContext('2d');
      ctx.fillStyle='blue';ctx.fillRect(0,0,mix.width,mix.height);ctx.drawImage(surface,0,0);
      const center=[...ctx.getImageData(16,10,1,1).data],margin=[...ctx.getImageData(0,0,1,1).data];
      disposePresentation();
      const nativeGpu=navigator.gpu, unavailable=[];
      let paintRejected=false,captureRejected=false;
      for(const [label,api] of [['missing-api',undefined],['missing-adapter',{requestAdapter:async()=>null}],
        ['device-failure',{requestAdapter:async()=>({requestDevice:async()=>{throw Error('Injected device failure');}})}],['missing-context',nativeGpu]]){
        denyContext=label==='missing-context';Object.defineProperty(navigator,'gpu',{value:api,configurable:true});
        let failed=false;try{await gpu.initializeGpuPresentation([source]);}catch(error){failed=/WebGPU/.test(error.message);}
        unavailable.push({label,failed});
        try{paintFrame(source,rgba(colors));}catch{paintRejected=true;}
        try{captureFrame(source);}catch{captureRejected=true;}
      }
      const hidden=source.classList.contains('frame-source');
      disposePresentation();HTMLCanvasElement.prototype.getContext=getContext;
      return {cases,native,hdr,rgbaPixels,expected:[...colors],alpha,center,margin,glContexts,eager,unavailable,paintRejected,captureRejected,hidden,surfaces:document.querySelectorAll('.frame-presentation').length};
    });
    for(const r of [...result.cases,...result.native,...result.hdr])assert.ok(r.max<=1,JSON.stringify(r));
    for(const r of result.hdr){assert.equal(r.executor,'webgpu-browser-sdr');assert.equal(r.repeat,0);}
    assert.deepEqual(result.rgbaPixels,result.expected);
    assert.deepEqual(result.alpha,[255,0,0,128]);assert.deepEqual(result.center,[128,0,127,255]);assert.deepEqual(result.margin,[0,0,255,255]);
    assert.equal(result.glContexts,0);assert.equal(result.surfaces,0);
    assert.ok(result.unavailable.every(r=>r.failed)&&result.paintRejected&&result.captureRejected&&result.hidden);
    console.log(`PASS ${name}: ${result.cases.length} YUV vectors, native rotations, RGBA alpha, HDR SDR intermediates, explicit unavailable errors without GL/2D fallback`);
    const recovery = await browser.newPage();
    recovery.on('pageerror', error => errors.push(error.message));
    await recovery.route('**/gpu-recovery-test', route => route.fulfill({contentType:'text/html',body:'<div class="frame-stage"><canvas id="source"></canvas></div>'}));
    await recovery.route('**/src/presentation/webgpu-color-surface.mjs*', route => route.fulfill({contentType:'text/javascript',body:`
      import { yuvToRgba } from '/shared/color/yuv-color.ts';
      window.testDevices = []; window.testSurfaces = []; window.releaseGpu = null;
      export async function createExternalSurface(canvas, shared) {
        let resolveLost;
        const device = shared ?? { alive:true, lost:new Promise(resolve => { resolveLost=resolve; }),
          lose(){ if(!this.alive)return;this.alive=false;resolveLost({reason:'unknown',message:'Injected device loss'}); },
          destroy(){this.lose();} };
        if (!shared) window.testDevices.push(device);
        if (window.deadNextDevice && !shared) { window.deadNextDevice=false;device.lose(); }
        if (!shared && (window.testDevices.length === 2 || window.holdNextGpu)) {
          window.holdNextGpu=false;await new Promise(resolve => { window.releaseGpu=resolve; });
        }
        let current, disposed=false;
        const surface = {device,lost:device.lost,errors:[],outputTarget:'sdr',outputFallbackReason:null,nativeHdrAvailable:false,
          nativeHdrReason:'unavailable',outputConfiguration:{displayHdr:false,format:'rgba8unorm',colorSpace:'srgb',toneMapping:'standard'},
          get available(){return device.alive&&!disposed;},setGeometry(){},
          present(frame){if(!this.available)throw Error('Lost');current={...frame,pixels:frame.pixels.slice()};},
          captureSource(target){if(!current)throw Error('No frame');target.width=current.width;target.height=current.height;
            target.getContext('2d').putImageData(new ImageData(yuvToRgba(current.description,current.pixels),current.width,current.height),0,0);return target;},
          clear(){current=null;},dispose(){if(disposed)return;disposed=true;this.clear();if(!shared)device.destroy();}};
        window.testSurfaces.push(surface);return surface;
      }
    `}));
    await recovery.goto(`http://127.0.0.1:${server.httpServer.address().port}/gpu-recovery-test`);
    await recovery.evaluate(async () => {
      const { setColorMode } = await import('/src/media/policy/color-mode.ts');setColorMode('reference');
      const gpu = await import('/src/presentation/webgpu-presenter.ts');
      const presenter = await import('/src/presentation/presenter.ts');
      const { yuvFixture } = await import('/test/helpers/yuv-fixture.ts');
      const { SessionResources } = await import('/src/session/resources.ts');
      const source=document.getElementById('source'), f=yuvFixture();
      const frame={kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3,byteSize:f.pixels.length};
      const resources=new SessionResources();let notices=0;
      presenter.bindPresentationResources(source,resources,()=>{notices++;});
      const geometry={width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:1};
      await gpu.initializeGpuPresentation([source]);presenter.setPresentationGeometry(source,geometry);presenter.paintFrame(source,frame);
      const read=()=>[...presenter.captureFrame(source).getContext('2d').getImageData(0,0,5,3).data];
      window.recoveryTest={gpu,presenter,source,resources,frame,expected:read(),read,notices:()=>notices};
      f.pixels.fill(0);window.testDevices[0].lose();
    });
    await recovery.waitForFunction(() => window.releaseGpu && document.getElementById('source').dataset.presentationRecovery === 'recovering');
    const during = await recovery.evaluate(() => {
      const t=window.recoveryTest;let rejected=false;
      try{t.read();}catch{rejected=true;}
      return {rejected,notices:t.notices(),devices:window.testDevices.length,hidden:t.source.classList.contains('frame-source')};
    });
    assert.deepEqual(during,{rejected:true,notices:0,devices:2,hidden:true},'loss never exposes a stale 2D source or reports successful recovery');
    await recovery.evaluate(() => window.releaseGpu());
    await recovery.waitForFunction(() => document.getElementById('source').dataset.presentationRecovery === 'ready');
    assert.deepEqual(await recovery.evaluate(()=>window.recoveryTest.read()),await recovery.evaluate(()=>window.recoveryTest.expected),'rebuild restores retained pixels after the decoder recycled its buffer');
    assert.equal(await recovery.evaluate(()=>window.recoveryTest.notices()),1);
    await recovery.evaluate(()=>window.testDevices[1].lose());
    await recovery.waitForFunction(()=>document.getElementById('source').dataset.presentationRecovery === 'failed');
    assert.equal(await recovery.evaluate(()=>window.testDevices.length),2,'repeated loss stops after one rebuild');
    assert.equal(await recovery.evaluate(()=>{try{window.recoveryTest.read();return false;}catch{return true;}}),true);
    await recovery.evaluate(async () => {
      window.deadNextDevice=true;let rejected=false;
      try{await window.recoveryTest.gpu.initializeGpuPresentation([window.recoveryTest.source]);}catch{rejected=true;}
      if(!rejected)throw Error('Already-lost initialization succeeded');
    });
    await recovery.evaluate(() => {
      window.holdNextGpu=true;window.releaseGpu=null;
      window.lateInitialization=window.recoveryTest.gpu.initializeGpuPresentation([window.recoveryTest.source]);
    });
    await recovery.waitForFunction(()=>window.releaseGpu);
    const remaining = await recovery.evaluate(() => {
      const t=window.recoveryTest;t.presenter.setPresentationGeometry(t.source,null);t.presenter.disposePresentation();
      window.releaseGpu();
      return window.lateInitialization.then(()=>({bytes:t.resources.totalBytes,live:window.testSurfaces.filter(s=>s.available).length,
        surfaces:document.querySelectorAll('.frame-presentation').length}));
    });
    assert.deepEqual(remaining,{bytes:0,live:0,surfaces:0});
    await recovery.close();
    assert.deepEqual(errors, [], 'presentation reports unavailable resources without uncaught page errors');
    console.log(`PASS ${name}: injected WebGPU loss, paused/latest frame redraw, bounded rebuild and complete resource cleanup`);
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await server.close(); }
