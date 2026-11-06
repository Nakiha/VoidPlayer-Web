import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
const server = await createServer({ server: { port: 0, host: '127.0.0.1' } });
await server.listen();
let browser;
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({locale:'zh-CN'});
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    await page.route('**/presentation-test', route => route.fulfill({ contentType: 'text/html', body: '<div class="frame-stage"><canvas id="source" width="2" height="2"></canvas></div>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/presentation-test`);
    const result = await page.evaluate(async () => {
      const { paintFrame, captureFrame, setPresentationGeometry, disposePresentation } = await import('/src/presentation/presenter.ts');
      const { VideoSample } = await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const source = document.getElementById('source');
      const geometry = { width: 200, height: 200, imageWidth: 200, imageHeight: 200, zoom: 1, offsetX: 0, offsetY: 0, dpr: 1 };
      setPresentationGeometry(source, geometry);
      let sourceContexts = 0;
      const original = source.getContext.bind(source);
      source.getContext = (...args) => { if (args[0] === '2d') sourceContexts++; return original(...args); };
      const colors = new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]);
      const {rgbaDescription}=await import('/shared/media/frame-description.ts');
      const {sampleDescription}=await import('/src/media/decoding/frame-resource.ts');
      const rgba = pixels => ({ description:rgbaDescription(2,2),kind: 'rgba8', width: 2, height: 2, pixels });
      paintFrame(source, rgba(colors));
      const eager = sourceContexts;
      const pixels = () => [...captureFrame(source).getContext('2d').getImageData(0, 0, source.width, source.height).data];
      const first = pixels();
      const input = document.createElement('canvas'); input.width = input.height = 2;
      input.getContext('2d').putImageData(new ImageData(colors, 2, 2), 0, 0);
      const sample = new VideoSample(new VideoFrame(input, { timestamp: 0 }));
      const beforeNative = sourceContexts;
      paintFrame(source, { description:sampleDescription(sample,16),kind: 'video-sample', width: 2, height: 2, sample }); sample.close();
      const nativeEager = sourceContexts - beforeNative;
      setPresentationGeometry(source, { ...geometry, zoom: 3, offsetX: 80 });
      const native = pixels();
      const rotated = new VideoSample(new VideoFrame(input, { timestamp: 0 }), { rotation: 90 });
      const expected = document.createElement('canvas'); expected.width = expected.height = 2;
      rotated.draw(expected.getContext('2d'), 0, 0, 2, 2);
      paintFrame(source, { description:sampleDescription(rotated,16),kind: 'video-sample', width: 2, height: 2, sample: rotated }); rotated.close();
      const rotation = pixels(), rotationExpected = [...expected.getContext('2d').getImageData(0,0,2,2).data];
      const recycled = new Uint8ClampedArray(colors); paintFrame(source, rgba(recycled)); recycled.fill(0);
      const retained = pixels();
      disposePresentation();
      // Force the existing 2D fallback; it must still show and capture the frame.
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl' ? null : getContext.call(this, type, ...args); };
      setPresentationGeometry(source, geometry); paintFrame(source, rgba(colors));
      const fallback = pixels(); disposePresentation();
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === 'webgl') return {createShader(){return {};},shaderSource(){},compileShader(){},getShaderParameter(){return false;},
          getShaderInfoLog(){return 'Injected shader setup failure';},getExtension(){return null;}};
        return getContext.call(this,type,...args);
      };
      setPresentationGeometry(source,geometry);paintFrame(source,rgba(colors));
      const failedGl = pixels();disposePresentation();
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (this.classList.contains('frame-presentation')) return null;
        return getContext.call(this,type,...args);
      };
      setPresentationGeometry(source,geometry);paintFrame(source,rgba(colors));
      const missingViewport = pixels(), sourceVisible = !source.classList.contains('frame-source');disposePresentation();
      HTMLCanvasElement.prototype.getContext = getContext;
      return { eager, nativeEager, first, native, rotation, rotationExpected, retained, fallback, failedGl, missingViewport, sourceVisible,
        expected: [...colors], surfaces: document.querySelectorAll('.frame-presentation').length };
    });
    assert.equal(result.eager, 0, 'RGBA playback does not draw the hidden canvas');
    assert.equal(result.nativeEager, 0, 'native playback does not draw the hidden canvas');
    for (const key of ['first','native','retained','fallback','failedGl','missingViewport']) assert.deepEqual(result[key], result.expected, key);
    assert.equal(result.sourceVisible,true,'unavailable viewport contexts do not hide a working source canvas');
    assert.deepEqual(result.rotation, result.rotationExpected);
    assert.equal(result.surfaces, 0);
    console.log(`PASS ${name}: direct native/RGBA upload, lazy pixels, rotation, buffer recycling, 2D fallback and cleanup`);
    const hdrResults = await page.evaluate(async () => {
      const { paintFrame, captureFrame, setPresentationGeometry, disposePresentation } = await import('/src/presentation/presenter.ts');
      const { VideoSample } = await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const source = document.getElementById('source');
      const geometry = { width: 200, height: 200, imageWidth: 200, imageHeight: 200, zoom: 1, offsetX: 0, offsetY: 0, dpr: 1 };
      const results = [];
      for (const transfer of ['pq', 'hlg']) {
        // Identical HDR pixels in distinct samples isolate presentation changes
        // from scene motion. Use real VideoFrame + Mediabunny clone semantics.
        const makeSample = timestamp => new VideoSample(new VideoFrame(new Uint8Array([40, 90, 140, 190, 128, 128]), {
          format: 'I420', codedWidth: 2, codedHeight: 2, timestamp,
          colorSpace: { primaries: 'bt2020', transfer, matrix: 'bt2020-ncl', fullRange: false },
        }));
        const {sampleDescription}=await import('/src/media/decoding/frame-resource.ts');
        const frame = sample => ({ description:sampleDescription(sample,16),kind: 'video-sample', width: 2, height: 2, sample });
        const pixels = () => [...captureFrame(source).getContext('2d').getImageData(0, 0, 2, 2).data];
        const primed = makeSample(0), clone = primed.clone();
        // Exactly the application sequence: draw first, then create the surface.
        paintFrame(source, frame(clone)); clone.close();
        const first = pixels();
        setPresentationGeometry(source, geometry);
        const initialized = pixels();
        const gl = document.querySelector('.frame-presentation').getContext('webgl');
        let nativeUploads = 0;
        const upload = gl.texImage2D.bind(gl);
        gl.texImage2D = (...args) => { if (args.at(-1) instanceof VideoFrame) nativeUploads++; return upload(...args); };
        const playback = [];
        for (let i = 1; i <= 3; i++) {
          const sample = makeSample(i * 40000);
          paintFrame(source, frame(sample)); sample.close(); playback.push(pixels());
        }
        const seek = primed.clone(); paintFrame(source, frame(seek)); seek.close();
        const sought = pixels();
        const roundtrip = primed.toVideoFrame();
        const metadata = { sample: primed.colorSpace.transfer, frame: roundtrip.colorSpace.transfer };
        roundtrip.close(); primed.close();
        // A following SDR frame must immediately regain direct upload.
        const sdr = new VideoSample(new VideoFrame(source, { timestamp: 200000 }));
        paintFrame(source, frame(sdr)); sdr.close();
        const sdrUploads = nativeUploads;
        disposePresentation();
        results.push({ transfer, first, initialized, playback, sought, metadata, sdrUploads });
      }
      return results;
    });
    for (const r of hdrResults) {
      assert.equal(r.metadata.sample, r.transfer); assert.equal(r.metadata.frame, r.transfer);
      assert.deepEqual(r.initialized, r.first, `${r.transfer}: surface creation`);
      for (const pixels of [...r.playback, r.sought]) assert.deepEqual(pixels, r.first, `${r.transfer}: HDR first/play/seek pixels`);
      assert.equal(r.sdrUploads, 1, 'only the following SDR frame uses native upload');
      assert.ok(new Set(r.first.filter((_, i) => i % 4 !== 3)).size > 1, 'HDR ramp is not blank');
    }
    console.log(`PASS ${name}: PQ/HLG clone metadata and first/play/seek pixel consistency; SDR direct upload restored`);
    const yuvResults=await page.evaluate(async()=>{
      const {paintFrame,captureFrame,setPresentationGeometry,disposePresentation}=await import('/src/presentation/presenter.ts');
      const {yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
      const {yuvToRgba}=await import('/shared/color/yuv-color.ts');
      const source=document.getElementById('source'),results=[];
      for(const depth of [8,10,12,16])for(const semi of [false,true])for(const full of [false,true])for(const matrix of ['bt709','smpte170m','bt2020-ncl']){
        const f=yuvFixture(depth,semi,full,matrix);
        const frame={kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3};
        // CPU first-frame path then GPU playback, independently quantized.
        paintFrame(source,frame);
        const reference=yuvToRgba(f.description,f.pixels);
        setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:2});
        paintFrame(source,frame);
        const actual=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
        results.push({depth,semi,full,matrix,max:Math.max(...actual.map((v,i)=>Math.abs(v-reference[i])))});
        disposePresentation();
      }
      for(const transfer of ['pq','hlg','smpte2084','arib-std-b67'])for(const depth of [10,12,16])for(const semi of [false,true]){
        const f=yuvFixture(depth,semi,false,'bt2020-ncl');f.description.color.transfer=transfer;
        const frame={kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3};
        paintFrame(source,frame);const reference=yuvToRgba(f.description,f.pixels);
        setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:2});paintFrame(source,frame);
        const actual=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
        results.push({depth,semi,transfer,max:Math.max(...actual.map((v,i)=>Math.abs(v-reference[i])))});disposePresentation();
      }
      const f=yuvFixture(10,true,false,'bt709',5,3,6);
      f.description.visibleRect={x:1,y:1,width:3,height:1};f.description.width=3;f.description.height=1;
      const reference=yuvToRgba(f.description,f.pixels);
      for(const rotation of [0,90,180,270]){
        const frame={kind:'yuv',description:f.description,pixels:f.pixels,width:3,height:1,sample:{rotation}};
        paintFrame(source,frame);
        const expected=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
        setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:2});paintFrame(source,frame);
        const actual=captureFrame(source).getContext('2d').getImageData(0,0,source.width,source.height).data;
        results.push({rotation,max:Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])))});disposePresentation();
      }
      for(const zoom of [.25,.6,1,3]){
        const f=yuvFixture(),rgba=yuvToRgba(f.description,f.pixels);
        const {rgbaDescription}=await import('/shared/media/frame-description.ts');
        setPresentationGeometry(source,{width:13,height:11,imageWidth:5,imageHeight:3,zoom,offsetX:1.2,offsetY:-.4,dpr:2});
        const read=()=>{const gl=document.querySelector('.frame-presentation').getContext('webgl');const out=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
        paintFrame(source,{kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3});const actual=read();
        paintFrame(source,{kind:'rgba8',description:rgbaDescription(5,3),pixels:rgba,width:5,height:3});const expected=read();
        results.push({viewportZoom:zoom,max:Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])))});disposePresentation();
      }
      const {sharePixelFrame}=await import('/src/media/decoding/pixel-frame.ts');
      const shared=yuvFixture(),sharedReference=yuvToRgba(shared.description,shared.pixels);
      let recycled=0;
      shared.pixels.slice=()=>{throw Error('Shared presentation copied a full frame');};
      const sharedFrame=sharePixelFrame({kind:'yuv',description:shared.description,pixels:shared.pixels,width:5,height:3,
        close(){recycled++;shared.pixels.fill(0);}});
      paintFrame(source,sharedFrame);sharedFrame.close();
      if(recycled!==0)throw Error('Displayed shared pixels were recycled early');
      const sharedActual=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
      results.push({sharedOwnership:true,max:Math.max(...sharedActual.map((v,i)=>Math.abs(v-sharedReference[i])))});
      disposePresentation();
      if(recycled!==1)throw Error('Displayed shared pixels were not released');
      const loss=yuvFixture();
      const lossFrame={kind:'yuv',description:loss.description,pixels:loss.pixels,width:5,height:3};
      setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:1});paintFrame(source,lossFrame);
      const surface=document.querySelector('.frame-presentation');
      const commit = lossFrame.presentedCommit;
      const originalPixels = loss.pixels.slice();
      loss.pixels.fill(0); // Decoder buffers may be recycled while the player is paused.
      const lost=new Promise(resolve=>surface.addEventListener('webglcontextlost',resolve,{once:true}));
      surface.getContext('webgl').getExtension('WEBGL_lose_context').loseContext();await lost;
      const recovered=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
      const cpu=yuvToRgba(loss.description,originalPixels);
      if (lossFrame.presentedCommit !== commit || source.dataset.presentationRecovery !== 'ready') throw new Error('Paused recovery changed frame identity or failed');
      results.push({contextLoss:source.dataset.colorExecutor,max:Math.max(...recovered.map((v,i)=>Math.abs(v-cpu[i])))});
      setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:2,offsetX:3,offsetY:-2,dpr:2});
      const resized=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
      results.push({contextLossResize:true,max:Math.max(...resized.map((v,i)=>Math.abs(v-cpu[i])))});
      disposePresentation();
      return results;
    });
    for(const r of yuvResults)assert.ok(r.max<=1,JSON.stringify(r));
    console.log(`PASS ${name}: ${yuvResults.length} YUV reference cases, range/matrix/depth/layout/crop/rotation`);
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
    await recovery.waitForFunction(() => window.releaseGpu && document.getElementById('source').dataset.presentationRecovery === 'ready');
    const during = await recovery.evaluate(() => {
      const t=window.recoveryTest;return {actual:t.read(),expected:t.expected,notices:t.notices(),devices:window.testDevices.length,commit:t.frame.presentedCommit};
    });
    assert.deepEqual(during.actual,during.expected,'paused frame survives recycled bytes and device loss');
    assert.equal(during.devices,2);assert.equal(during.notices,1);
    await recovery.evaluate(async () => {
      const t=window.recoveryTest,{yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
      const f=yuvFixture();f.pixels[0]=235;
      t.latest={...t.frame,pixels:f.pixels};t.presenter.paintFrame(t.source,t.latest);t.latestExpected=t.read();
      window.releaseGpu();
    });
    await recovery.waitForFunction(() => document.getElementById('source').dataset.colorExecutor === 'webgpu-yuv');
    assert.deepEqual(await recovery.evaluate(()=>window.recoveryTest.read()),await recovery.evaluate(()=>window.recoveryTest.latestExpected),'recovery redraws the latest frame');
    await recovery.evaluate(()=>window.testDevices[1].lose());
    await recovery.waitForFunction(()=>document.getElementById('source').dataset.colorExecutor !== 'webgpu-yuv');
    assert.equal(await recovery.evaluate(()=>window.testDevices.length),2,'repeated loss stops after one rebuild');
    assert.deepEqual(await recovery.evaluate(()=>window.recoveryTest.read()),await recovery.evaluate(()=>window.recoveryTest.latestExpected));
    await recovery.evaluate(async () => {
      window.deadNextDevice=true;
      await window.recoveryTest.gpu.initializeGpuPresentation([window.recoveryTest.source]);
    });
    assert.deepEqual(await recovery.evaluate(()=>window.recoveryTest.read()),await recovery.evaluate(()=>window.recoveryTest.latestExpected),'already-lost device keeps the fallback frame');
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
    assert.deepEqual(errors, [], 'presentation failures recover without uncaught page errors');
    console.log(`PASS ${name}: injected WebGPU loss, paused/latest frame redraw, bounded rebuild and complete resource cleanup`);
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await server.close(); }
