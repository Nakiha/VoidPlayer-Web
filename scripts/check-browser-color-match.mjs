// Browser color mode two-path on-screen check (Windows Chrome/Edge).
// Native video-sample (browser-managed) vs real WASM yuv (profile-approximated)
// painted through the production presenter with getColorMode()==='browser'.
// WASM raw bytes are verified against FFmpeg CLI reference, so a remaining RGB
// gap isolates the yuv2rgb/browser-texture presentation difference, not decode.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform, release, arch } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const rawArgs = process.argv.slice(2);
const channels = [];
let localFile;
let limit = 2;
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--file') { assert.ok(rawArgs[i + 1], '--file needs a local path'); localFile = resolve(rawArgs[++i]); }
  else if (arg === '--limit') { limit = Number(rawArgs[++i]); assert.ok(Number.isInteger(limit) && limit >= 0, '--limit must be a non-negative integer'); }
  else channels.push(arg);
}
if (!channels.length) channels.push('chrome', 'msedge');
if (channels.some(c => !['chrome', 'msedge'].includes(c))) throw new Error('Expected chrome and/or msedge');
if (platform() !== 'win32') throw new Error('Run Windows acceptance on Windows');

const out = resolve(localFile ? 'artifacts/color/browser-match-file' : 'artifacts/color/browser-match');
await mkdir(out, { recursive: true });

const w = 192, h = 144;
const cases = localFile ? [] : [
  { name: 'h264-709-limited', encoder: 'libx264', depth: 8, matrix: 'bt709', primaries: 'bt709', fullRange: false },
  { name: 'h264-709-full', encoder: 'libx264', depth: 8, matrix: 'bt709', primaries: 'bt709', fullRange: true },
  { name: 'h264-601', encoder: 'libx264', depth: 8, matrix: 'smpte170m', primaries: 'smpte170m', fullRange: false },
  { name: 'h264-2020-sdr', encoder: 'libx264', depth: 8, matrix: 'bt2020nc', primaries: 'bt2020', fullRange: false },
  { name: 'hevc-709-8bit', encoder: 'libx265', depth: 8, matrix: 'bt709', primaries: 'bt709', fullRange: false },
  { name: 'hevc-709-10bit', encoder: 'libx265', depth: 10, matrix: 'bt709', primaries: 'bt709', fullRange: false },
];

const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
for (const c of cases) {
  const bytes = c.depth === 8 ? 1 : 2, scale = 2 ** (c.depth - 8), raw = Buffer.alloc(w * h * 3 / 2 * bytes);
  const patches = [[16, 128, 128], [235, 128, 128], [64, 128, 128], [160, 128, 128],
    [100, 80, 180], [140, 180, 80], [120, 70, 90], [150, 170, 160],
    [100, 110, 150], [180, 140, 100], [80, 160, 140], [200, 100, 120]];
  let offset = 0;
  for (let plane = 0; plane < 3; plane++) {
    const pw = plane ? w / 2 : w, ph = plane ? h / 2 : h;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      let code = patches[Math.min(2, Math.floor(y * 3 / ph)) * 4 + Math.floor(x * 4 / pw)][plane];
      if (c.fullRange && plane === 0) code = Math.round((code - 16) * 255 / 219);
      if (bytes === 1) raw[offset++] = code; else { raw.writeUInt16LE(code * scale, offset); offset += 2; }
    }
  }
  const input = resolve(out, `${c.name}.input.yuv`), video = resolve(out, `${c.name}.mp4`), reference = resolve(out, `${c.name}.decoded.yuv`);
  await writeFile(input, raw);
  const pix = c.depth === 8 ? 'yuv420p' : 'yuv420p10le';
  ffmpeg(['-f', 'rawvideo', '-pixel_format', pix, '-video_size', `${w}x${h}`, '-framerate', '2', '-i', input,
    '-vf', 'loop=loop=3:size=1:start=0', '-frames:v', '4', '-c:v', c.encoder, '-preset', 'fast',
    ...(c.encoder === 'libx264' ? ['-qp', '1', '-g', '4', '-bf', '0'] : ['-x265-params', 'qp=1:keyint=4:bframes=0:log-level=error']),
    '-color_range', c.fullRange ? 'pc' : 'tv', '-colorspace', c.matrix, '-color_primaries', c.primaries, '-color_trc', 'bt709',
    '-tag:v', c.encoder === 'libx264' ? 'avc1' : 'hvc1', video]);
  ffmpeg(['-i', video, '-frames:v', '4', '-f', 'rawvideo', '-pix_fmt', pix, reference]);
  c.video = video; c.reference = reference; c.width = w; c.height = h; c.times = [0, 1000000, 0]; c.indices = [0, 2, 0];
  c.probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', video], { encoding: 'utf8' })).streams[0];
  const decoded = await readFile(reference); assert.equal(decoded.length, w * h * 3 / 2 * bytes * 4);
  c.referenceSha256 = createHash('sha256').update(decoded).digest('hex');
}

if (localFile) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+3', '-show_streams', '-show_frames', '-of', 'json', localFile], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 }));
  const stream = probe.streams[0];
  assert.ok(['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(stream.pix_fmt), 'Only planar 420 8/10-bit SDR input supported');
  assert.ok(stream.width * stream.height <= 16777216 && stream.width % 2 === 0 && stream.height % 2 === 0, 'Reference requires even dimensions within 16M pixels');
  assert.ok(!['smpte2084', 'arib-std-b67'].includes(stream.color_transfer), 'SDR only');
  const selected = [0, 1, 2].map(time => Math.max(0, probe.frames.findLastIndex(f => Number(f.best_effort_timestamp_time) <= time)));
  assert.ok(selected.every(i => i >= 0)); assert.equal(new Set(selected).size, 3, 'Need distinct frames at 0/1/2 seconds');
  const frame = probe.frames[selected[0]], depth = stream.pix_fmt.endsWith('10le') ? 10 : 8, reference = resolve(out, 'local.decoded.yuv');
  for (const index of selected) for (const key of ['width', 'height', 'pix_fmt', 'color_space', 'color_range', 'color_transfer', 'color_primaries']) assert.equal(probe.frames[index][key], frame[key], `Reference ${key} changed`);
  assert.ok(!['smpte2084', 'arib-std-b67'].includes(frame.color_transfer), 'SDR frames only');
  ffmpeg(['-i', localFile, '-vf', `select=${selected.map(i => `eq(n\\,${i})`).join('+')}`, '-fps_mode', 'passthrough', '-frames:v', '3', '-pix_fmt', depth === 10 ? 'yuv420p10le' : 'yuv420p', '-f', 'rawvideo', reference]);
  const raw = await readFile(reference); assert.equal(raw.length, stream.width * stream.height * 3 / 2 * (depth === 10 ? 2 : 1) * 3);
  cases.push({ name: 'user-local', video: localFile, reference, width: stream.width, height: stream.height, depth,
    matrix: frame.color_space ?? stream.color_space ?? null, primaries: frame.color_primaries ?? stream.color_primaries ?? null,
    transfer: frame.color_transfer ?? stream.color_transfer ?? null, fullRange: (frame.color_range ?? stream.color_range) === 'pc',
    times: selected.map(i => Math.round(Number(probe.frames[i].best_effort_timestamp_time) * 1e6)), indices: [0, 1, 2],
    probe: stream, referenceFrames: selected.map(i => probe.frames[i]), referenceSha256: createHash('sha256').update(raw).digest('hex') });
}

const evidence = { colorMode: 'browser', startedAt: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch() },
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  measurement: 'Browser color mode on-screen capture: native video-sample (browser-managed) vs real WASM yuv (profile-approximated); WASM bytes verified against FFmpeg CLI; diagnostic-only fixed sweep (baseline/matrix601/xGamma22/matrix601Gamma22, no fitted params, no production change); excludes OS/display composition',
  interiorMaxErrorLimit: limit, results: [] };

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser;
let failed = false;
try {
  await server.listen();
  for (const channel of channels) {
    const entry = { channel, colorMode: 'browser', cases: [] };
    evidence.results.push(entry);
    let deadline;
    try {
      browser = await chromium.launch({ channel, headless: false, ...(channel === 'chrome' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
      entry.version = browser.version();
      const runningBrowser = browser;
      deadline = setTimeout(() => { entry.timeout = true; void runningBrowser.close(); }, 240000);
      entry.executableOverride = channel === 'chrome' ? process.env.CHROME_EXECUTABLE_PATH ?? null : null;
      const page = await browser.newPage();
      page.setDefaultTimeout(90000);
      entry.pageErrors = [];
      page.on('pageerror', e => entry.pageErrors.push(String(e)));
      await page.route(/\/browser-match(?:\?.*)?$/, r => r.fulfill({ headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }, contentType: 'text/html', body: '<input type="file"><div class="frame-stage"><canvas id="native"></canvas></div><div class="frame-stage"><canvas id="software"></canvas></div>' }));
      await page.route('**/color-reference/*', async r => {
        const c = cases.find(c => r.request().url().endsWith('/' + c.name));
        if (!c) return r.abort();
        await r.fulfill({ contentType: 'application/octet-stream', body: await readFile(c.reference) });
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/browser-match`);
      entry.environment = await page.evaluate(async () => {
        const { setColorMode, getColorMode } = await import('/src/color-mode.ts');
        setColorMode('browser');
        const { initializeGpuPresentation } = await import('/src/webgpu-presenter.ts');
        await initializeGpuPresentation([...document.querySelectorAll('canvas')]);
        const { detectGpuProfile } = await import('/src/webgpu-calibration.ts');
        const profile = await detectGpuProfile().catch(() => null);
        const adapter = await navigator.gpu?.requestAdapter(), info = adapter?.info;
        const { buildInfo } = await import('/src/build-info.ts');
        return { buildInfo, colorMode: getColorMode(), profile,
          crossOriginIsolated, active: document.querySelectorAll('.frame-presentation').length === 2,
          userAgent: navigator.userAgent,
          adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null };
      });
      assert.equal(entry.environment.colorMode, 'browser', 'Page must run in browser color mode');
      assert.ok(entry.environment.adapter && !entry.environment.adapter.isFallbackAdapter, 'Hardware GPU adapter required');
      for (const c of cases) {
        try {
          await page.locator('input').setInputFiles(c.video);
          const result = await page.evaluate(async ({ c, w, h }) => {
            const { openMedia } = await import('/src/media.ts');
            const { openPacketMedia } = await import('/src/packet-media.ts');
            const { paintFrame, captureFrame, setPresentationGeometry } = await import('/src/presenter.ts');
            const { compareRgba } = await import('/src/color-evidence.ts');
            const file = document.querySelector('input').files[0];
            const reference = new Uint8Array(await (await fetch(`/color-reference/${c.name}`)).arrayBuffer());
            const native = await openMedia(file, async () => {
              const { readLogs } = await import('/src/log.ts');
              throw new Error(`Native decoder unavailable: ${JSON.stringify((await readLogs({ limit: 10 })).events)}`);
            });
            if (native.info.decoder !== 'webcodecs') {
              const decoder = native.info.decoder;
              native.dispose();
              throw new Error(`Native path did not stay hardware/browser-managed (got ${decoder}); cannot count as native-vs-software comparison`);
            }
            const software = await openPacketMedia('mp4', { file }, file, { forceWasm: true });
            const canvases = [document.querySelector('#native'), document.querySelector('#software')];
            const result = { name: c.name, info: native.info, softwareInfo: software.info, ffprobe: c.probe, referenceFrames: c.referenceFrames, referenceSha256: c.referenceSha256, pairs: [] };
            const geometry = { width: w, height: h, imageWidth: w, imageHeight: h, zoom: 1, offsetX: 0, offsetY: 0, dpr: 1 };
            const pixelsOf = canvas => {
              const shown = captureFrame(canvas);
              return shown.getContext('2d').getImageData(0, 0, shown.width, shown.height).data;
            };
            const interior = data => {
              if (c.name === 'user-local') return data;
              const kept = [];
              for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const bx = x % (w / 4), by = y % (h / 3);
                if (bx < 8 || bx > w / 4 - 9 || by < 8 || by > h / 3 - 9) continue;
                kept.push(...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
              }
              return new Uint8ClampedArray(kept);
            };
            try {
              for (const [index, pts] of c.times.entries()) {
                let nativeFrame, softwareFrame;
                try {
                  nativeFrame = await native.frameAt(pts);
                  softwareFrame = await software.frameAt(pts);
                  if (nativeFrame.kind !== 'video-sample') throw new Error(`Native path must stay browser-managed video-sample, got ${nativeFrame.kind}`);
                  if (softwareFrame.kind !== 'yuv') throw new Error(`Software path must stay yuv planes, got ${softwareFrame.kind}`);
                  if (nativeFrame.sourcePtsUs !== pts || softwareFrame.sourcePtsUs !== pts) throw new Error(`Different PTS: native ${nativeFrame.sourcePtsUs} software ${softwareFrame.sourcePtsUs} vs ${pts}`);
                  if (nativeFrame.width !== w || nativeFrame.height !== h || softwareFrame.width !== w || softwareFrame.height !== h) throw new Error('Native/software dimensions differ');
                  const bytes = c.depth === 8 ? 1 : 2, length = w * h * 3 / 2 * bytes;
                  const raw = reference.slice(c.indices[index] * length, (c.indices[index] + 1) * length);
                  if (softwareFrame.pixels.length !== raw.length) throw new Error('WASM/reference byte length mismatch');
                  let softwareRawMax = 0;
                  for (let i = 0; i < raw.length; i++) softwareRawMax = Math.max(softwareRawMax, Math.abs(raw[i] - softwareFrame.pixels[i]));
                  if (softwareRawMax !== 0) throw new Error(`WASM raw bytes differ from FFmpeg CLI: max ${softwareRawMax}`);
                  for (const canvas of canvases) setPresentationGeometry(canvas, geometry);
                  paintFrame(canvases[0], nativeFrame);
                  paintFrame(canvases[1], softwareFrame);
                  const a = pixelsOf(canvases[0]), b = pixelsOf(canvases[1]);
                  const baselineFull = compareRgba(a, b), baselineInterior = compareRgba(interior(a), interior(b));
                  // Diagnostic-only sweep: fixed named equations, never fitted
                  // parameters, never relabels sources, never alters the
                  // baseline native/software pair or pass/fail. Mac/default
                  // pipeline untouched: this repaints the same WASM bytes with
                  // an overridden matrix and/or a fixed GAMMA22->sRGB post step
                  // purely to report per-browser closeness.
                  const gamma22ToSrgb = data => {
                    const out = new Uint8ClampedArray(data);
                    for (let i = 0; i < out.length; i++) {
                      if (i % 4 === 3) continue;
                      const v = (data[i] / 255) ** 2.2;
                      out[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
                    }
                    return out;
                  };
                  const diagnosticDescription = { ...softwareFrame.description, color: { ...softwareFrame.description.color, matrix: 'smpte170m' } };
                  paintFrame(canvases[1], { ...softwareFrame, description: diagnosticDescription });
                  const m601 = pixelsOf(canvases[1]);
                  const g22 = gamma22ToSrgb(b), m601g22 = gamma22ToSrgb(m601);
                  const sweep = {
                    baseline: { full: baselineFull, interior: baselineInterior },
                    matrix601: { full: compareRgba(a, m601), interior: compareRgba(interior(a), interior(m601)) },
                    baselineGamma22: { full: compareRgba(a, g22), interior: compareRgba(interior(a), interior(g22)) },
                    matrix601Gamma22: { full: compareRgba(a, m601g22), interior: compareRgba(interior(a), interior(m601g22)) },
                  };
                  const sweepBest = Object.entries(sweep).sort(([, x], [, y]) => (x.interior.max - y.interior.max) || (x.full.max - y.full.max))[0][0];
                  result.pairs.push({ pts, sourcePtsUs: nativeFrame.sourcePtsUs,
                    softwarePtsUs: softwareFrame.sourcePtsUs, softwareRawMax,
                    nativeDescription: nativeFrame.description, softwareDescription: softwareFrame.description,
                    executors: canvases.map(v => v.dataset.colorExecutor),
                    contracts: canvases.map(v => v.dataset.colorContract),
                    full: baselineFull, interior: baselineInterior, sweep, sweepBest });
                } finally { nativeFrame?.close(); softwareFrame?.close(); for (const canvas of canvases) setPresentationGeometry(canvas, null); }
              }
            } finally { native.dispose(); software.dispose(); }
            return result;
          }, { c, w: c.width, h: c.height });
          entry.cases.push(result);
          const interiorMax = Math.max(...result.pairs.map(p => p.interior.max));
          const fullMax = Math.max(...result.pairs.map(p => p.full.max));
          result.passed = result.pairs.length === (localFile ? 3 : 3) && result.pairs.every(pair => pair.interior.max <= limit && pair.executors.join(',') === 'webgpu-external,webgpu-yuv');
          if (!result.passed) failed = true;
          console.log(`${channel} ${c.name}: interior max ${interiorMax}, full max ${fullMax}, executors ${result.pairs[0]?.executors.join(',')}, contracts ${result.pairs[0]?.contracts.join(',')}, sweepBest ${result.pairs.map(p => p.sweepBest).join('/')}`);
        } catch (e) { entry.cases.push({ name: c.name, error: String(e), passed: false }); failed = true; console.error(`${channel} ${c.name}: ${e}`); }
      }
      entry.logs = await page.evaluate(async () => {
        const { disposePresentation } = await import('/src/presenter.ts');
        disposePresentation();
        const { readLogs } = await import('/src/log.ts');
        return await readLogs({ limit: 100 });
      });
      if (entry.pageErrors.length) failed = true;
    } catch (e) { entry.error = String(e); failed = true; console.error(`${channel}: ${e}`); }
    finally { clearTimeout(deadline); await browser?.close(); browser = undefined; }
  }
} catch (error) { failed = true; evidence.error = String(error); throw error; }
finally { await browser?.close(); await server.close(); evidence.passed = !failed; await writeFile(resolve(out, 'report.json'), JSON.stringify(evidence, null, 2)); }
console.log(`Local evidence: ${resolve(out, 'report.json')}`);
console.log('Note: browser color mode is approximate by design (docs/color-pipeline.md); a non-zero exit proves the two on-screen paths differ and does not certify reference-color correctness.');
if (failed) process.exitCode = 1;
