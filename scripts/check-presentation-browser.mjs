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
      const rgba = pixels => ({ kind: 'rgba8', width: 2, height: 2, pixels });
      paintFrame(source, rgba(colors));
      const eager = sourceContexts;
      const pixels = () => [...captureFrame(source).getContext('2d').getImageData(0, 0, source.width, source.height).data];
      const first = pixels();
      const input = document.createElement('canvas'); input.width = input.height = 2;
      input.getContext('2d').putImageData(new ImageData(colors, 2, 2), 0, 0);
      const sample = new VideoSample(new VideoFrame(input, { timestamp: 0 }));
      const beforeNative = sourceContexts;
      paintFrame(source, { kind: 'video-sample', width: 2, height: 2, sample }); sample.close();
      const nativeEager = sourceContexts - beforeNative;
      setPresentationGeometry(source, { ...geometry, zoom: 3, offsetX: 80 });
      const native = pixels();
      const rotated = new VideoSample(new VideoFrame(input, { timestamp: 0 }), { rotation: 90 });
      const expected = document.createElement('canvas'); expected.width = expected.height = 2;
      rotated.draw(expected.getContext('2d'), 0, 0, 2, 2);
      paintFrame(source, { kind: 'video-sample', width: 2, height: 2, sample: rotated }); rotated.close();
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
        const frame = sample => ({ kind: 'video-sample', width: 2, height: 2, sample });
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
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await server.close(); }
