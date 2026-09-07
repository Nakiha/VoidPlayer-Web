import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
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
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (/voidplayer-core.*\.(js|wasm)$/.test(req.url())) wasmRequests.push(req.url()); });
  await page.goto(fixture.base); await page.waitForFunction(() => !!window.voidPlayer);
  const call = (name, params = {}) => page.evaluate(({ name, params }) => window.voidPlayer.tools.find(t => t.name === name).execute(params), { name, params });
  const start = performance.now();
  const first = await within(call('load_library_item', { id: fixture.entry.id, slot: 'A' }), 8000);
  const startupMs = Math.round(performance.now() - start);
  assert.equal(first.tracks[0].decoder, 'webcodecs'); assert.equal(first.tracks[0].frame.ptsUs, 0);
  assert.equal(first.tracks[0].indexState, 'building'); assert.equal(wasmRequests.length, 0, 'native startup never fetches a WASM core');
  await page.screenshot({ path: `/tmp/voidplayer-flv-startup-${browserName}.png` });
  await within(call('seek_review', { ptsUs: 0 }), 3000);
  let finished = false; const seek = call('seek_review', { ptsUs: 2500000 }).then(s => { finished = true; return s; });
  await new Promise(r => setTimeout(r, 100)); assert.equal(finished, false); assert.ok(fixture.counts().delayed > 0);
  fixture.release(); const complete = await seek; assert.equal(complete.tracks[0].indexState, 'complete');
  await page.waitForFunction(async () => (await (await fetch('/api/admin/frame-indexes')).json()).count === 1);
  await call('remove_review_track', { slot: 'A' }); const before = fixture.counts().ranges;
  await call('load_library_item', { id: fixture.entry.id, slot: 'A' }); const reused = await call('seek_review', { ptsUs: 2500000 });
  assert.equal(reused.tracks[0].indexSource, 'server'); assert.ok(fixture.counts().ranges - before < 10);
  await call('seek_review', { ptsUs: 0 });
  const benchmark = await call('benchmark_review', { durationMs: 1500 }); assert.equal(benchmark.passed, true, JSON.stringify(benchmark));
  const list = await call('list_frame_indexes'); assert.equal(list.count, 1);
  const admin = await browser.newPage(); await admin.goto(fixture.base + '/admin');
  await admin.locator('[data-pane="frame-indexes"]').click();
  await admin.locator('.admin-frame-index-row').waitFor();
  await admin.screenshot({ path: `/tmp/voidplayer-frame-indexes-${browserName}.png` });
  await admin.getByRole('button', { name: '清理 startup.flv 的帧索引', exact: true }).click();
  await admin.locator('#frame-index-confirm-delete').click();
  await admin.waitForFunction(() => document.querySelector('#frame-index-summary').textContent.startsWith('0 个'));
  assert.equal((await call('list_frame_indexes')).count, 0);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({ path: `/tmp/voidplayer-frame-indexes-mobile-${browserName}.png` });
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // MCP mutations use the same endpoint and permission checks as the UI.
  assert.deepEqual(await call('clear_frame_indexes', { scope: 'all' }), { removed: 0 });
  assert.deepEqual(errors, []);
  console.log(`PASS ${browserName}: first frame ${startupMs} ms with 256 MiB tail blocked; no WASM load, cached reopening, playback, admin UI and MCP`);
} finally { await browser?.close(); await fixture.close(); }
