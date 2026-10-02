// Real HLG packet decoding: independent FFprobe display clock, full tail,
// repeated seeks/steps, and same-browser pixel identity across decoder resets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const engine = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(engine));
const file = new URL('../fixtures/video/dolby_hlg_1080p30.mp4', import.meta.url);
const size = (await stat(file)).size;
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', fileURLToPath(file)], { encoding: 'utf8' }));
const expected = probe.frames.map(frame => Math.round(Number(frame.best_effort_timestamp_time) * 1e6));
assert.ok(expected.length > 15 && expected.every((pts, i) => Number.isSafeInteger(pts) && (!i || pts > expected[i - 1])));
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage(), errors = [], ranges = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('dolby_hlg_1080p30.mp4')) ranges.push(request.headers().range); });
  await page.route('**/hlg-test', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/hlg-test`);
  const results = await page.evaluate(async ({ size, expected }) => {
    const { Mp4Engine } = await import('/src/mp4-engine.ts');
    const assert = (value, message) => { if (!value) throw Error(message); };
    const url = new URL('/fixtures/video/dolby_hlg_1080p30.mp4', location.href).href;
    const signatures = new Map(), rows = [];
    for (const remote of [true, false]) {
      const source = new Mp4Engine(remote ? { url, size } : { file: new Blob([await (await fetch(url)).arrayBuffer()]) });
      const row = { remote, count: 0, pixelChecks: 0, seeks: [] };
      const inspect = async (output, ordinal) => {
        try {
          assert(!!output && Math.abs(output.pts - expected[ordinal]) <= 2, `frame ${ordinal}: PTS=${output?.pts}, expected=${expected[ordinal]}`);
          const frame = output.frame;
          let bytes, plane, depth, shift = 0, width, height, channels = 1, sampleBytes;
          if (frame && ['NV12', 'I420', 'I420P10', 'RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(frame.format)) {
            bytes = new Uint8Array(frame.allocationSize());
            [plane] = await frame.copyTo(bytes); depth = frame.format === 'I420P10' ? 10 : 8;
            channels = frame.format.includes('RGB') || frame.format.includes('BGR') ? 3 : 1;
            sampleBytes = channels === 3 ? 4 : depth > 8 ? 2 : 1;
            width = frame.visibleRect.width; height = frame.visibleRect.height;
          } else if (output.pixels && output.description.yuv) {
            bytes = new Uint8Array(output.pixels);
            const yuv = output.description.yuv;
            [plane] = yuv.planes; depth = yuv.bitDepth; shift = yuv.bitShift;
            sampleBytes = depth > 8 ? 2 : 1;
            width = plane.width; height = plane.height;
          } else if (output.pixels && output.description.format === 'RGBA') {
            bytes = new Uint8Array(output.pixels); depth = 8; channels = 3; sampleBytes = 4;
            plane = { offset: 0, stride: output.description.stride };
            width = output.description.width; height = output.description.height;
          }
          row.outputFormat = frame?.format ?? output.description.format;
          if (bytes) {
            const signature = [];
            for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
              const offset = plane.offset + Math.floor((y + .5) * height / 18) * plane.stride + Math.floor((x + .5) * width / 32) * sampleBytes;
              for (let c = 0; c < channels; c++) signature.push(((bytes[offset + c] + (depth > 8 ? bytes[offset + c + 1] * 256 : 0)) >>> shift) / 2 ** (depth - 8));
            }
            const previous = signatures.get(ordinal);
            if (previous) { assert(signature.reduce((n, value, i) => n + Math.abs(value - previous[i]), 0) / signature.length < 1.3, `seek changed picture ${ordinal}`); row.pixelChecks++; }
            else signatures.set(ordinal, signature);
          }
          return output.pts;
        } finally { output?.frame?.close(); }
      };
      try {
        const { times: _times, durations: _durations, ...info } = await source.open(new URL('/vendor/voidplayer-core/voidplayer-core.js', location.href).href, undefined, false);
        row.info = info;
        let frame = await source.at(expected[0]);
        for (let i = 0; i < expected.length; i++) {
          const pts = await inspect(frame, i); row.count++;
          frame = await source.next(pts);
        }
        assert(frame === null, 'unexpected extra tail frame');
        for (const i of [0, 8, 9, 10, Math.floor(expected.length / 2), expected.length - 2, expected.length - 1, 0]) {
          const pts = await inspect(await source.at(expected[i]), i);
          if (i + 1 < expected.length) await inspect(await source.next(pts), i + 1);
          else assert(await source.next(pts) === null, 'EOF step must end');
          row.seeks.push(i);
        }
        rows.push(row);
      } finally { source.close(); }
    }
    return rows;
  }, { size, expected });
  for (const row of results) assert.ok(row.pixelChecks > 0, 'seek/step pixel identity was verified');
  if (engine === 'webkit' && process.platform === 'darwin') for (const row of results) {
    assert.equal(row.info.decoder, 'webcodecs'); assert.equal(row.info.hardwareAcceleration, 'prefer-hardware'); assert.ok(row.pixelChecks > 0);
  }
  assert.ok(ranges.some(range => range?.startsWith('bytes=')), 'remote decoding uses Range');
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: HLG ${expected.length} frames, full tail, repeated seek/step, pixel identity and local/Range inputs`);
  console.log(JSON.stringify(results));
} finally { try { await browser?.close(); } finally { await server.close(); } }
