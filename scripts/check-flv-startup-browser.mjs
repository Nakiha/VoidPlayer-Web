import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('.run/playback-reports', { recursive: true });
import { chromium, webkit } from 'playwright';
import { resolutionFlv, prerollMp4 } from './flv-resolution-fixture.ts';
import { startupFixture } from './flv-startup-fixture.ts';
const browserName = process.argv[2] ?? 'chromium', fixture = await startupFixture();
let browser;
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup waited for the blocked tail')), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage(), errors = [], wasmRequests = [];
  await page.addInitScript(() => {
    window.testDecoders = []; window.testDecoderConfigurations = 0;
    const Native = VideoDecoder;
    window.VideoDecoder = class extends Native {
      constructor(init) { super(init); window.testDecoders.push(this); }
      configure(config) { window.testDecoderConfigurations++; return super.configure(config); }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (/voidplayer-core.*\.(js|wasm)$/.test(req.url())) wasmRequests.push(req.url()); });
  await page.goto(fixture.base); await page.waitForFunction(() => !!window.voidPlayer);
  const call = (name, params = {}) => page.evaluate(({ name, params }) => window.voidPlayer.tools.find(t => t.name === name).execute(params), { name, params });
  const start = performance.now();
  const first = await within(call('load_library_item', { id: fixture.entry.id, slot: 'A' }), 8000);
  const startupMs = Math.round(performance.now() - start);
  assert.equal(first.tracks[0].decoder, 'webcodecs'); assert.equal(first.tracks[0].frame.ptsUs, 0);
  assert.equal(first.tracks[0].indexState, 'building'); assert.equal(wasmRequests.length, 0, 'native startup never fetches a WASM core');
  await page.screenshot({ path: `.run/playback-reports/flv-startup-${browserName}.png` });
  await within(call('seek_review', { ptsUs: 0 }), 3000);
  let finished = false; const seek = call('seek_review', { ptsUs: 2500000 }).then(s => { finished = true; return s; });
  await new Promise(r => setTimeout(r, 100)); assert.equal(finished, false); assert.ok(fixture.counts().delayed > 0);
  fixture.release(); const complete = await seek; assert.equal(complete.tracks[0].indexState, 'complete');
  assert.match(complete.tracks[0].indexWarning, /尾部不完整/);
  assert.match(await page.locator('#meta-A').textContent(), /尾部不完整/);
  await page.waitForFunction(async () => (await (await fetch('/api/admin/frame-indexes')).json()).count === 1);
  await call('remove_review_track', { slot: 'A' }); const before = fixture.counts().ranges;
  await call('load_library_item', { id: fixture.entry.id, slot: 'A' }); const reused = await call('seek_review', { ptsUs: 2500000 });
  assert.equal(reused.tracks[0].indexSource, 'server'); assert.match(reused.tracks[0].indexWarning, /尾部不完整/); assert.ok(fixture.counts().ranges - before < 10);
  await call('seek_review', { ptsUs: 0 });
  const benchmark = await call('benchmark_review', { durationMs: 1500 }); assert.equal(benchmark.passed, true, JSON.stringify(benchmark));
  const list = await call('list_frame_indexes'); assert.equal(list.count, 1);
  const admin = await browser.newPage(); await admin.goto(fixture.base + '/admin');
  await admin.locator('[data-pane="frame-indexes"]').click();
  await admin.locator('.admin-frame-index-row').waitFor();
  await admin.screenshot({ path: `.run/playback-reports/frame-indexes-${browserName}.png` });
  await admin.getByRole('button', { name: '清理 startup.flv 的帧索引', exact: true }).click();
  await admin.locator('#frame-index-confirm-delete').click();
  await admin.waitForFunction(() => document.querySelector('#frame-index-summary').textContent.startsWith('0 个'));
  assert.equal((await call('list_frame_indexes')).count, 0);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({ path: `.run/playback-reports/frame-indexes-mobile-${browserName}.png` });
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // MCP mutations use the same endpoint and permission checks as the UI.
  assert.deepEqual(await call('clear_frame_indexes', { scope: 'all' }), { removed: 0 });
  for (const codec of ['h264', 'hevc']) {
    const bytes = [...await resolutionFlv(codec)];
    await page.evaluate(async ({ bytes, codec }) => {
      await window.voidPlayer.loadFile('A', new File([Uint8Array.from(bytes)], `resolution-${codec}.flv`));
    }, { bytes, codec });
    for (const [ptsUs, width, height] of [[1100000, 640, 360], [400000, 320, 180], [1900000, 640, 360], [0, 320, 180]]) {
      const state = await call('seek_review', { ptsUs });
      assert.equal(state.tracks[0].width, width); assert.equal(state.tracks[0].height, height);
    }
    const report = await call('benchmark_review', { durationMs: 1500 });
    assert.equal(report.error, null); assert.ok(report.measurements.mediaUs > 1000000, JSON.stringify(report));
    assert.match(await page.locator('#meta-A').textContent(), /640 × 360/);
    await page.screenshot({ path: `.run/playback-reports/flv-resolution-${codec}-${browserName}.png` });
  }
  // Portrait geometry must agree across the source, displayed metadata and capture.
  const portrait = [...await resolutionFlv('hevc', ['244x436'])];
  const portraitState = await page.evaluate(async bytes => window.voidPlayer.loadFile('A', new File([Uint8Array.from(bytes)], 'portrait.flv')), portrait);
  assert.equal(portraitState.tracks[0].width, 244); assert.equal(portraitState.tracks[0].height, 436);
  const capture = await page.evaluate(() => { const c = window.voidPlayer.captureFrame('A'); return { width:c.width,height:c.height }; });
  assert.deepEqual(capture, { width:244,height:436 });
  await page.screenshot({ path: `.run/playback-reports/hevc-portrait-${browserName}.png` });
  await call('remove_review_track', { slot:'A' });
  const preroll = [...await prerollMp4()];
  for (let round=0; round<3; round++) {
    await page.evaluate(async bytes => window.voidPlayer.loadFile('A', new File([Uint8Array.from(bytes)], 'preroll.mp4')), preroll);
    const configurations = await page.evaluate(() => window.testDecoderConfigurations);
    for (let i=0;i<3;i++) await call('seek_review', {ptsUs:0});
    assert.equal(await page.evaluate(() => window.testDecoderConfigurations), configurations, 'repeated first-frame access does not decode again');
    await page.evaluate(async bytes => window.voidPlayer.loadFile('B', new File([Uint8Array.from(bytes)], 'preroll-b.mp4')), preroll);
    await page.evaluate(() => window.voidPlayer.play());
    await page.waitForFunction(() => window.voidPlayer.getState().positionUs > 100000);
    await call('pause_review');
    await call('remove_review_track',{slot:'B'}); await call('remove_review_track',{slot:'A'});
    await page.waitForFunction(() => window.testDecoders.every(d => d.state === 'closed'));
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${browserName}: first frame ${startupMs} ms with 256 MiB tail blocked; no WASM load, cached reopening, playback, admin UI and MCP`);
} finally { await browser?.close(); await fixture.close(); }
