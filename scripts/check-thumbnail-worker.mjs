// Measure the actual CPU-thumbnail path, with no decoder or media URL available.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
const web = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await web.listen();
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('**/thumbnail-test', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
      await page.goto('http://127.0.0.1:' + web.httpServer.address().port + '/thumbnail-test');
      const ranges = [];
      page.on('request', request => { if (request.headers().range || /\/api\/media\//.test(request.url())) ranges.push(request.url()); });
      const result = await page.evaluate(async () => {
        const { offerFirstFrameCandidate } = await import('/src/thumbnails/offer.ts');
        const { runThumbnailTask } = await import('/src/thumbnails/tasks.ts');
        const { thumbnailState } = await import('/src/thumbnails/state.ts');
        const { rgbaDescription } = await import('/src/frame-description.ts');
        const { getLiveObjectUrl } = await import('/src/thumbnails/client.ts');
        const { getLocalThumbnail } = await import('/src/thumbnails/local-store.ts');
        const { renderThumbnailCanvas } = await import('/src/presenter.ts');
        const small = renderThumbnailCanvas({ kind: 'rgba8', width: 2, height: 2,
          description: rgbaDescription(2, 2), pixels: Uint8ClampedArray.from([
            0,0,0,255, 255,255,255,255, 255,255,255,255, 0,0,0,255,
          ]) }, 1);
        const pixel = small.canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
        if (pixel[0] !== 128 || pixel[1] !== 128 || pixel[2] !== 128) throw Error('downscale must interpolate source pixels');
        const longTasks = [];
        let observer;
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
          observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
          observer.observe({ type: 'longtask' });
        }
        const timings = [];
        // Repeat to include both cold Worker startup and warm module cache.
        for (let n = 0; n < 6; n++) {
          const isYuv = n >= 3, w = 3840, h = 2160, luma = w * h;
          const pixels = new Uint8ClampedArray(isYuv ? luma * 1.5 : luma * 4); pixels.fill(128);
          let description = rgbaDescription(w, h);
          if (isYuv) {
            pixels.fill(81, 0, luma); pixels.fill(90, luma, luma * 1.25); pixels.fill(240, luma * 1.25);
            description = { ...description, format: 'I420', stride: null, byteLength: pixels.length,
              color: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false },
              yuv: { bitDepth: 8, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: null,
                planes: [{ offset: 0, stride: w, width: w, height: h },
                  { offset: luma, stride: w / 2, width: w / 2, height: h / 2 },
                  { offset: luma * 1.25, stride: w / 2, width: w / 2, height: h / 2 }] } };
          }
          const byteLength = pixels.byteLength;
          const source = { description, width: w, height: h, kind: isYuv ? 'yuv' : 'rgba8', rotation: isYuv ? 90 : 0, pixels, byteSize: pixels.byteLength, ptsUs: 0, sourcePtsUs: 0, durationUs: 40000, close() { throw Error('playback frame closed'); } };
          const start = performance.now();
          const offer = offerFirstFrameCandidate({ cacheKey: 'worker-' + n, kind: 'local', sourceGen: n, sourcePtsUs: 0, isFileFirst: true, byteSize: pixels.byteLength }, source);
          if (typeof offer !== 'object') throw Error('offer rejected: ' + offer);
          timings.push(performance.now() - start);
          runThumbnailTask(offer);
          const deadline = performance.now() + 3000;
          while (thumbnailState.inFlight.size && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
          if (thumbnailState.inFlight.size || thumbnailState.holdingFull) throw Error('resource still held');
          if (pixels.byteLength !== byteLength) throw Error('playback buffer detached');
          if (n === 5 && !await getLocalThumbnail('worker-' + n)) throw Error('local thumbnail was not persisted');
          const url = getLiveObjectUrl('worker-' + n);
          if (url && isYuv) {
            const image = new Image(); image.src = url; await image.decode();
            if (image.naturalWidth !== 216 || image.naturalHeight !== 384) throw Error('rotation geometry');
            const canvas = new OffscreenCanvas(1, 1), ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, 1, 1);
            const actual = ctx.getImageData(0, 0, 1, 1).data;
            if ([255, 24, 0].some((value, i) => Math.abs(value - actual[i]) > 5)) throw Error('YUV color: ' + actual);
          }
          if (n === 5 && !url) throw Error('warm YUV worker did not complete: ' + JSON.stringify(thumbnailState.snapshot()));

        }
        await new Promise(r => setTimeout(r, 50));
        observer?.disconnect();
        return { timings, longTasks, state: thumbnailState.snapshot() };
      });
      assert.ok(result.state.rendered > 0, JSON.stringify(result));
      assert.deepEqual(ranges, [], 'thumbnail executor performs no media requests');
      console.log(JSON.stringify({ engine: name, ...result }));
    } finally { await browser.close(); }
  }
} finally { await web.close(); }
