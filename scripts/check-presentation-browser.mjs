import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
const server = await createServer({ server: { port: 0, host: '127.0.0.1' } });
await server.listen();
let browser;
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('**/presentation-test', route => route.fulfill({ contentType: 'text/html', body: '<div class="frame-stage"><canvas id="source" width="2" height="2"></canvas></div>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/presentation-test`);
    const result = await page.evaluate(async () => {
      const { paintFrame, captureFrame, setPresentationGeometry, disposePresentation } = await import('/src/presenter.ts');
      const { VideoSample } = await import('/node_modules/mediabunny/dist/modules/src/index.js');
      const source = document.getElementById('source');
      const geometry = { width: 200, height: 200, imageWidth: 200, imageHeight: 200, zoom: 1, offsetX: 0, offsetY: 0, dpr: 1 };
      setPresentationGeometry(source, geometry);
      let sourceContexts = 0;
      const original = source.getContext.bind(source);
      source.getContext = (...args) => { if (args[0] === '2d') sourceContexts++; return original(...args); };
      const colors = new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]);
      const {rgbaDescription,sampleDescription}=await import('/src/frame-description.ts');
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
      HTMLCanvasElement.prototype.getContext = getContext;
      return { eager, nativeEager, first, native, rotation, rotationExpected, retained, fallback, expected: [...colors], surfaces: document.querySelectorAll('.frame-presentation').length };
    });
    assert.equal(result.eager, 0, 'RGBA playback does not draw the hidden canvas');
    assert.equal(result.nativeEager, 0, 'native playback does not draw the hidden canvas');
    for (const key of ['first','native','retained','fallback']) assert.deepEqual(result[key], result.expected, key);
    assert.deepEqual(result.rotation, result.rotationExpected);
    assert.equal(result.surfaces, 0);
    console.log(`PASS ${name}: direct native/RGBA upload, lazy pixels, rotation, buffer recycling, 2D fallback and cleanup`);
    const hdrResults = await page.evaluate(async () => {
      const { paintFrame, captureFrame, setPresentationGeometry, disposePresentation } = await import('/src/presenter.ts');
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
        const {sampleDescription}=await import('/src/frame-description.ts');
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
      const {paintFrame,captureFrame,setPresentationGeometry,disposePresentation}=await import('/src/presenter.ts');
      const {yuvFixture}=await import('/test/helpers/yuv-fixture.ts');
      const {yuvToRgba}=await import('/src/yuv-color.ts');
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
        const {rgbaDescription}=await import('/src/frame-description.ts');
        setPresentationGeometry(source,{width:13,height:11,imageWidth:5,imageHeight:3,zoom,offsetX:1.2,offsetY:-.4,dpr:2});
        const read=()=>{const gl=document.querySelector('.frame-presentation').getContext('webgl');const out=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
        paintFrame(source,{kind:'yuv',description:f.description,pixels:f.pixels,width:5,height:3});const actual=read();
        paintFrame(source,{kind:'rgba8',description:rgbaDescription(5,3),pixels:rgba,width:5,height:3});const expected=read();
        results.push({viewportZoom:zoom,max:Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])))});disposePresentation();
      }
      const loss=yuvFixture();
      const lossFrame={kind:'yuv',description:loss.description,pixels:loss.pixels,width:5,height:3};
      setPresentationGeometry(source,{width:100,height:60,imageWidth:100,imageHeight:60,zoom:1,offsetX:0,offsetY:0,dpr:1});paintFrame(source,lossFrame);
      const surface=document.querySelector('.frame-presentation');
      const lost=new Promise(resolve=>surface.addEventListener('webglcontextlost',resolve,{once:true}));
      surface.getContext('webgl').getExtension('WEBGL_lose_context').loseContext();await lost;
      paintFrame(source,lossFrame);
      const recovered=captureFrame(source).getContext('2d').getImageData(0,0,5,3).data;
      const cpu=yuvToRgba(loss.description,loss.pixels);
      results.push({contextLoss:source.dataset.colorExecutor,max:Math.max(...recovered.map((v,i)=>Math.abs(v-cpu[i])))});
      disposePresentation();
      return results;
    });
    for(const r of yuvResults)assert.ok(r.max<=1,JSON.stringify(r));
    console.log(`PASS ${name}: ${yuvResults.length} YUV reference cases, range/matrix/depth/layout/crop/rotation`);
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await server.close(); }
