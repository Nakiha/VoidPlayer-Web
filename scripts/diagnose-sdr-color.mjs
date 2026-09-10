// Local opt-in probe. Uses production FLV decoding and presenter; never changes
// color tags or uploads files/reports. Run from repository root with Node 24+.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2), files = [];
let channel, out = 'color-evidence', times = [0, 1000000], images = false, headless = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--channel') channel = args[++i];
  else if (arg === '--out') out = args[++i];
  else if (arg === '--times-us') times = args[++i].split(',').map(Number);
  else if (arg === '--images') images = true;
  else if (arg === '--headless') headless = true;
  else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
  else files.push(resolve(arg));
}
if (!files.length || files.length > 4 || !out || times.length < 1 || times.length > 8 || times.some(t => !Number.isSafeInteger(t) || t < 0))
  throw new Error('Usage: node scripts/diagnose-sdr-color.mjs [--channel msedge|chrome] [--out DIR] [--times-us 0,1000000] [--images] FILE.flv [FILE.flv]');
await mkdir(out, { recursive: true });
const report = { schema: 2, startedAt: new Date().toISOString(), requestedTimesUs: times, channel: channel ?? 'bundled-chromium', headless,
  measurement: 'source-sized presenter capture in sRGB bytes; excludes OS/display composition; not a color-accuracy verdict', files: [] };
try { report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { report.commit = 'unknown'; }
report.core = JSON.parse(await readFile('scripts/release-core.json', 'utf8'));
const server = await createServer({ server: { port: 0, host: '127.0.0.1' } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel, headless });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  page.setDefaultTimeout(180000);
  await page.route('**/color-evidence', route => route.fulfill({ contentType: 'text/html', body: '<title>Local SDR color evidence</title><input type="file"><p>Local diagnostic in progress. No media upload.</p>' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/color-evidence`);
  await page.exposeFunction('saveEvidenceImage', async (name, data) => {
    if (!images || !/^file-\d+-time-\d+-(native|native-canvas|wasm)\.png$/.test(name)) throw new Error('Invalid evidence image');
    await writeFile(resolve(out, name), Buffer.from(data.split(',')[1], 'base64'));
  });
  for (const [fileNumber, path] of files.entries()) {
    const before = await stat(path), entry = { file: basename(path), size: before.size, modifiedMs: before.mtimeMs };
    report.files.push(entry);
    try {
      // Independent decoded-frame tags, not only stream/container tags.
      entry.ffprobe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#30',
        '-show_entries', 'stream=codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries:frame=pts_time,pix_fmt,color_range,color_space,color_transfer,color_primaries',
        '-of', 'json', path], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch { entry.ffprobeUnavailable = true; }
    try {
      await page.locator('input').setInputFiles(path);
      entry.probe = await page.evaluate(async ({ times, images, fileNumber }) => {
        const { openFlvMedia } = await import('/src/flv-media.ts');
        const { paintFrame, captureFrame, setPresentationGeometry } = await import('/src/presenter.ts');
        const { presentationColor } = await import('/src/presentation-color.ts');
        const { summarizeRgba, compareRgba } = await import('/src/color-evidence.ts');
        const { buildInfo } = await import('/src/build-info.ts');
        const { readLogs } = await import('/src/log.ts');
        const sinceSeq = (await readLogs({ limit: 1 })).lastSeq;
        const file = document.querySelector('input').files[0], sources = {}, results = [];
        const result = { buildInfo, userAgent: navigator.userAgent, secureContext: isSecureContext, crossOriginIsolated, native: {}, wasm: {}, frames: results };
        // A real file input retains Blob range reads; no base64/full-file copy.
        if (String.fromCharCode(...new Uint8Array(await file.slice(0, 3).arrayBuffer())) !== 'FLV') throw new Error('This probe currently accepts FLV only');
        const controller = new AbortController();
        const deadline = setTimeout(() => {
          controller.abort(new Error('Color probe timed out'));
          for (const source of Object.values(sources)) source.dispose();
        }, 150000);
        try {
          for (const mode of ['native', 'wasm']) {
            try {
              const source = await openFlvMedia({ file }, file, { forceWasm: mode === 'wasm', signal: controller.signal });
              result[mode] = { info: { ...source.info }, requested: mode };
              if (mode === 'native' && source.info.decoder !== 'webcodecs') {
                result[mode].unavailable = 'Native attempt fell back to WASM; cannot count as a native/hardware comparison'; source.dispose();
              } else sources[mode] = source;
            } catch (e) { result[mode].error = String(e); }
          }
          for (const target of times) {
            const pair = { requestedPtsUs: target }, pixels = {};
            results.push(pair);
            for (const mode of ['native', 'wasm']) {
              const source = sources[mode]; if (!source) continue;
              let frame;
              const stage = document.createElement('div'); stage.className = 'frame-stage';
              const canvas = document.createElement('canvas'); stage.append(canvas); document.body.append(stage);
              try {
                frame = await source.frameAt(target);
                if (frame.width * frame.height > 16777216) throw new Error('Capture exceeds 16M pixel diagnostic budget');
                setPresentationGeometry(canvas, { width: frame.width, height: frame.height, imageWidth: frame.width, imageHeight: frame.height, zoom: 1, offsetX: 0, offsetY: 0, dpr: 1 });
                paintFrame(canvas, frame);
                const capture = captureFrame(canvas);
                const data = capture.getContext('2d').getImageData(0, 0, capture.width, capture.height).data;
                const policy = presentationColor(frame.kind, frame.description);
                pair[mode] = { ptsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs, width: frame.width, height: frame.height,
                  description: frame.description, policy, summary: summarizeRgba(data),
                  renderer: stage.querySelector('.frame-presentation')?.getContext('webgl') ? 'webgl' : 'canvas2d' };
                pixels[mode] = data;
                if (images) await window.saveEvidenceImage(`file-${fileNumber}-time-${target}-${mode}.png`, capture.toDataURL('image/png'));
                if (mode === 'wasm' && frame.pixels) {
                  // No source-tag reinterpretation: this only checks whether
                  // uploading/capturing the already-RGBA bytes changes them.
                  pair.wasmInputToPresenter = compareRgba(frame.pixels, data);
                }
                if (mode === 'native') {
                  // Reuse this exact decoded sample, not another seek/decode.
                  // A canvas without a presentation surface selects the real
                  // presenter's existing sRGB 2D path without patching globals.
                  const fallback = document.createElement('canvas');
                  try {
                    paintFrame(fallback, frame);
                    pixels.nativeCanvas = fallback.getContext('2d').getImageData(0, 0, fallback.width, fallback.height).data;
                    pair.nativeCanvas = { path: 'presenter-canvas2d-srgb', sameDecodedFrame: true, summary: summarizeRgba(pixels.nativeCanvas) };
                    if (pair.native.renderer === 'webgl') pair.nativeDirectToCanvas = compareRgba(data, pixels.nativeCanvas);
                    else pair.nativeCanvas.notCompared = 'Production capture already used Canvas 2D; no WebGL baseline';
                    if (images) await window.saveEvidenceImage(`file-${fileNumber}-time-${target}-native-canvas.png`, fallback.toDataURL('image/png'));
                  } catch (e) { pair.nativeCanvas = { error: String(e) }; }
                  finally { fallback.width = fallback.height = 1; }
                }
              } catch (e) { pair[mode] = { error: String(e) }; }
              finally { frame?.close(); setPresentationGeometry(canvas, null); stage.remove(); }
            }
            const a = pair.native, b = pair.wasm;
            if (!pixels.native || !pixels.wasm) pair.notCompared = 'Both decode paths did not produce a capture';
            else if (a.sourcePtsUs !== b.sourcePtsUs || a.width !== b.width || a.height !== b.height) pair.notCompared = 'Actual source PTS or dimensions differ; do not compare different frames';
            else if (a.policy.hdr || a.policy.sourceHdr || b.policy.hdr || b.policy.sourceHdr) pair.notCompared = 'HDR metadata detected; outside this SDR probe';
            else {
              pair.nativeToWasm = compareRgba(pixels.native, pixels.wasm);
              if (pixels.nativeCanvas) pair.nativeCanvasToWasm = compareRgba(pixels.nativeCanvas, pixels.wasm);
            }
          }
          result.diagnostics = await readLogs({ sinceSeq, limit: 200 });
          return result;
        } finally { clearTimeout(deadline); controller.abort(); for (const source of Object.values(sources)) source.dispose(); }
      }, { times, images, fileNumber });
    } catch (e) { entry.error = String(e); }
    const after = await stat(path);
    entry.fileUnchanged = after.size === before.size && after.mtimeMs === before.mtimeMs;
    console.log(`${entry.file}: ${entry.error ? 'probe failed' : 'evidence collected'}`);
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  }
} catch (e) { report.error = String(e); process.exitCode = 1; }
finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`Local report: ${resolve(out, 'report.json')}`);
