// Production Worker path: native-decode rejection must lead to bounded packet IO.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { RangeReader } from '../src/range-reader.ts';
import { readMp4Configurations } from '../src/mp4-config.ts';
import { mp4BoundaryFixture } from './mp4-boundary-fixture.ts';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root = path.resolve(import.meta.dirname, '..');
const name = process.argv[2] ?? 'webkit';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-range-browser-'));
const boundary = await mp4BoundaryFixture();
await writeFile(path.join(temporary, 'h264_boundary.mp4'), boundary.oversized);
const tableReader = new RangeReader({ file: new Blob([boundary.valid]) });
const table = await readMp4Configurations(tableReader, 1); tableReader.close();
await writeFile(path.join(temporary, 'h264_truncated.mp4'), boundary.valid.subarray(0, table.sampleOffsets[13] + 1));
const server = createMediaServer({ roots: [path.join(root, 'fixtures/video'), temporary], staticDir: path.join(root, 'dist'), onLog() {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await (name === 'chromium' ? chromium : webkit).launch({ headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const file of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'ffv1_yuv422p_8bit.mkv', 'h264_boundary.mp4', 'h264_truncated.mp4']) {
    const page = await browser.newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/media\/[0-9a-f]+$/.test(new URL(r.url()).pathname)) requests.push(r.headers()); });
    try {
      await page.goto(base); await page.waitForFunction(() => !!window.voidPlayer);
      const result = await page.evaluate(async file => {
        const call = (name, params = {}) => window.voidPlayer.tools.find(t => t.name === name).execute(params);
        const listing = await call('list_library', { search: file });
        const item = listing.entries.find(e => e.name === file);
        if (!item) throw new Error('Missing Range fixture: ' + file);
        await call('load_library_item', { id: item.id, slot: 'A' });
        const first = await call('get_review_session');
        const duration = first.tracks[0].durationUs;
        for (const ptsUs of [Math.floor(duration * .6), 0, duration - 1, 0]) await call('seek_review', { ptsUs });
        await call('step_review', { direction: 1 });
        const last = await call('get_review_session');
        const bench = await call('benchmark_review', { durationMs: 1000 });
        return { first, last, bench };
      }, file);
      assert.deepEqual(errors, []);
      // New Chromium builds can decode High 4:2:2 natively. Preserve the
      // capability-first policy; VVC and FFV1 exercise mandatory WASM here.
      if (!file.startsWith('h264_')) assert.equal(result.first.tracks[0].decoder, 'ffmpeg-wasm');
      else assert.ok(['webcodecs', 'ffmpeg-wasm'].includes(result.first.tracks[0].decoder));
      if (file === 'h264_boundary.mp4') {
        assert.equal(result.first.tracks[0].decoder, 'webcodecs', 'intact samples in an overdeclared mdat retain native decoding');
        assert.match(result.first.tracks[0].indexWarning, /mdat/);
      }
      if (file === 'h264_truncated.mp4') {
        assert.equal(result.first.tracks[0].decoder, 'webcodecs', 'tail truncation alone must not force software decoding');
        assert.equal(result.first.tracks[0].durationUs, 1300000);
        assert.match(result.first.tracks[0].indexWarning, /前 13 个完整视频包/);
      }
      assert.ok(result.last.tracks[0].frame.ptsUs > 0);
      assert.ok(requests.length > 0 && requests.every(r => /^bytes=/.test(r.range ?? '')));
      assert.ok(!result.bench.error, JSON.stringify(result.bench));
      // VVC CPU throughput is reported, not an absolute machine-specific gate.
      console.log(JSON.stringify({ browser: name, file, reads: requests.length, benchmark: result.bench }));
    } finally { await page.close(); }
  }
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
