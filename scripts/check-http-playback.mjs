// Real ordinary-HTTP playback, repeated source-button clicks and decoder cleanup.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';
import { prepareTls } from '../server/tls.ts';
import { trustTestCertificate } from './test-certificate-trust.mjs';

const root = path.resolve(import.meta.dirname, '..');
const secure = process.env.VOIDPLAYER_HTTPS_TEST === '1';
const protocol = secure ? 'https' : 'http';
const temporary = await mkdtemp(path.join(tmpdir(), 'vp-network-playback-'));
const tls = secure ? await prepareTls({ hosts: ['voidplayer.test'] }, temporary) : undefined;
const library = new MediaLibraryIndex([path.join(root, '.run/playback-media')]);
const listing = await library.list();
listing.entries.sort((a, b) => a.name.localeCompare(b.name));
assert.equal(listing.entries.length, 2, 'run make-playback-fixtures.mjs first');
assert.ok(listing.entries.every(e => e.size > 90000000), 'use real ~100 MB files');
const server = createMediaServer({ roots: library.roots, library, tls, staticDir: path.join(root, 'dist'), onLog() {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `${protocol}://voidplayer.test:${server.address().port}`;
const reports = [];
let browser, untrust;
await mkdir(path.join(root, '.run/playback-reports'), { recursive: true });
try {
  if (tls) untrust = await trustTestCertificate(tls.caFile);
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP voidplayer.test 127.0.0.1', '--no-proxy-server', '--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(90000);
  const errors = [], workers = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => { workers.add(worker); worker.on('close', () => workers.delete(worker)); });
  const requests = [];
  page.on('request', request => { if (/\/api\/media\/[^/]+(?:\?|$)/.test(new URL(request.url()).pathname)) requests.push(request.url()); });
  await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
  assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof VideoDecoder, crossOriginIsolated]), secure ? [true, 'function', true] : [false, 'undefined', false]);
  await page.locator('#start-library-more').click();
  const entry = listing.entries.find(e => e.name === 'http-1080p-a.mp4');
  const row = page.locator('#source-list .source-row').filter({ hasText: entry.name });
  const add = row.getByRole('button', { name: `添加到视图：${entry.name}`, exact: true });
  let releaseDownload;
  const blocked = new Promise(resolve => { releaseDownload = resolve; });
  await page.route('**/api/media/**', async route => { await blocked; await route.continue(); });
  await add.click();
  await page.waitForFunction(() => document.querySelector('#source-list [aria-busy="true"]'));
  assert.equal(await add.isDisabled(), true);
  await add.evaluate(button => { for (let i = 0; i < 30; i++) button.click(); });
  releaseDownload();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy);
  await page.unroute('**/api/media/**');
  if (!secure) assert.equal(requests.length, 1, 'repeated + clicks must start exactly one file download');
  assert.equal(workers.size, secure ? 0 : 1, 'WebCodecs must not open WASM workers');
  assert.equal(await row.getAttribute('aria-busy'), 'false');
  assert.match(await row.innerText(), /使用中/);
  console.log(`PASS ${protocol} + button: immediate pending state, repeated clicks, first frame, correct decoder`);

  const cdp = await browser.newBrowserCDPSession();
  async function residentBytes() {
    if (process.platform !== 'linux') return null;
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    // Sum private resident pages (USS), including workers in renderer
    // processes and GPU allocations resident in the browser process tree.
    let bytes = 0;
    for (const p of processInfo) {
      try {
        const smaps = await readFile(`/proc/${p.id}/smaps_rollup`, 'utf8');
        for (const match of smaps.matchAll(/^Private_(?:Clean|Dirty):\s+(\d+) kB$/gm)) bytes += Number(match[1]) * 1024;
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    return bytes;
  }
  for (let round = 1; round <= 3; round++) {
    for (const [i, item] of listing.entries.entries()) {
      if (round === 1 && item.id === entry.id) continue;
      await page.evaluate(({ id, slot }) => window.voidPlayer.tools.find(t => t.name === 'load_library_item').execute({ id, slot }), { id: item.id, slot: i ? 'B' : 'A' });
    }
    assert.equal(workers.size, secure ? 0 : 2);
    const report = await page.evaluate(() => window.voidPlayer.tools.find(t => t.name === 'benchmark_review').execute({ durationMs: 12000 }));
    assert.equal(report.error, null);
    assert.equal(report.staleAfterPause, false);
    assert.equal(report.tracks.length, 2);
    for (const track of report.tracks) {
      assert.equal(track.decoder, secure ? 'webcodecs' : 'ffmpeg-wasm');
      if (secure) assert.ok(['prefer-hardware', 'no-preference'].includes(track.hardwareAcceleration));
      else assert.equal(track.coreVariant, 'single-thread');
    }
    for (const queue of Object.values(report.measurements.buffers)) {
      assert.ok(queue.peakFrames <= 4, 'queue frame cap');
      assert.ok(queue.peakBytes <= 4 * 1920 * 1080 * 4, 'queue byte cap');
    }
    const loadedBytes = await residentBytes();
    await page.evaluate(async () => { for (const t of window.voidPlayer.getState().tracks) await window.voidPlayer.removeTrack(t.slot); });
    for (let i = 0; i < 100 && workers.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(workers.size, 0, 'removing both tracks must release both workers');
    const unloadedBytes = await residentBytes();
    reports.push({ round, loadedBytes, unloadedBytes, report });
    console.log(JSON.stringify({ round, loadedBytes, unloadedBytes, performancePassed: report.passed, failures: report.failures, measurements: report.measurements }));
  }
  if (reports.every(r => r.loadedBytes !== null)) {
    assert.ok(Math.max(...reports.map(r => r.loadedBytes)) < 1536 * 1024 * 1024, '1080p dual-track browser private resident memory stays below 1.5 GiB');
    assert.ok(reports[2].unloadedBytes - reports[0].unloadedBytes < 256 * 1024 * 1024, 'repeated close/reopen does not accumulate hundreds of MiB');
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${protocol} repeated dual-track playback: bounded buffers, decoder cleanup, stable resident memory`);
  await browser.close(); browser = null;

  // Run the repository's benchmark unchanged at the session/tool boundary.
  const child = spawn(process.execPath, ['scripts/bench-playback.mjs', 'chromium', '--headless'], { cwd: root, stdio: 'inherit', env: {
    ...process.env, BASE_URL: base, BENCH_HTTP: '1', BENCH_REPEATS: '2', BENCH_DURATION_MS: '12000',
    BENCH_SCENARIOS: JSON.stringify({ [`${protocol}-1080p-solo`]: ['http-1080p-a.mp4'], [`${protocol}-1080p-dual`]: ['http-1080p-a.mp4', 'http-1080p-b.mp4'] }),
    BENCH_REPORT: path.join(root, '.run/playback-reports/benchmark.json'),
  } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, 'HTTP playback benchmark thresholds');
} finally {
  await writeFile(path.join(root, '.run/playback-reports/repeated-playback.json'), JSON.stringify(reports, null, 2));
  await browser?.close();
  untrust?.();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(temporary, { recursive: true, force: true });
}
