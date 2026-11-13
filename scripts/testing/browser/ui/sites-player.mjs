// Bounded Sites acceptance: real static files and decoders, no media API or Node service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from '../../browser-engines.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const engine = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(engine));
execFileSync(process.execPath, ['scripts/build-sites.mjs'], { cwd: root, stdio: 'pipe' });
const dist = path.join(root, 'artifacts/sites/dist');
const evidence = path.join(root, '.run/sites-browser', engine);
await mkdir(evidence, { recursive: true });
const video = path.join(evidence, 'ci_h264_smoke.mp4');
const software = path.join(evidence, 'local-ffv1.mkv');
const avi = path.join(evidence, 'local-mjpeg.avi');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-bf', '0', video]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-t', '1', '-c:v', 'mjpeg', avi]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-t', '1', '-c:v', 'ffv1', software]);
await assert.rejects(access(path.join(dist, 'admin/index.html')));
await assert.rejects(access(path.join(dist, 'sw.js')));
await assert.rejects(access(path.join(dist, 'manifest.webmanifest')));
assert.deepEqual(JSON.parse(await readFile(path.join(dist, '../.openai/hosting.json'), 'utf8')), { static: { directory: 'dist' } });
let isolated = false;
const apiRequests = [], failures = [];
const mimes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { apiRequests.push(url.pathname); response.writeHead(404).end(); return; }
    const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
    if (isolated) {
      response.setHeader('cross-origin-opener-policy', 'same-origin');
      response.setHeader('cross-origin-embedder-policy', 'require-corp');
    }
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', mimes[path.extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser;
const rows = [];
try {
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
  for (isolated of [false, true]) {
    const context = await browser.newContext({ locale: isolated ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    context.on('page', page => {
      page.on('pageerror', error => failures.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(base + '/?workspace=00000000-0000-4000-8000-000000000000&annotation=unavailable&library=invalid');
    await page.waitForFunction(() => window.voidPlayer && !document.querySelector('#app').hasAttribute('data-initializing'));
    assert.equal(await page.evaluate(() => crossOriginIsolated), isolated);
    assert.equal(await page.locator('#identity-welcome').count(), 0);
    for (const selector of ['#workspace-share', '.connection-control', '#start-identity', '#copy-path-A', '#source-action-A'])
      assert.equal(await page.locator(selector).isVisible(), false, selector + ' is absent from the local flow');
    const tools = await page.evaluate(() => window.voidPlayer.tools.map(tool => tool.name));
    for (const name of ['share_state', 'list_library', 'load_library_item', 'list_frame_indexes', 'clear_frame_indexes'])
      assert.ok(!tools.includes(name), name + ' is not exposed');
    await page.locator('#settings-open').click();
    assert.equal(await page.locator('#settings-tab-identity').count(), 0);
    for (const tab of ['workspace', 'logs', 'performance', 'about', 'appearance']) {
      await page.locator('#settings-tab-' + tab).click();
      if (tab === 'logs') assert.equal(await page.locator('[data-action="upload"]').isVisible(), false);
      if (tab === 'about') assert.equal(await page.locator('#web-app').isVisible(), false);
    }
    await page.locator('#settings-close').click();
    await page.locator('#file-A').setInputFiles(video);
    await page.waitForFunction(() => !window.voidPlayer.getState().busy && window.voidPlayer.getState().tracks[0]?.frame);
    const first = await page.evaluate(() => window.voidPlayer.getState().tracks[0]);
    assert.ok(first.width > 0 && first.height > 0);
    await page.evaluate(async () => { await window.voidPlayer.step(1); await window.voidPlayer.seek(0); });
    if (!isolated) {
      const analysis = await page.evaluate(async () => {
        const api = window.voidPlayer, position = api.getState().positionUs;
        const result = await api.tools.find(tool => tool.name === 'request_bitstream_analysis').execute({ slot: 'A' });
        return { schema: result.schema, codec: result.codec, blocks: result.blocks.length, before: position, after: api.getState().positionUs };
      });
      assert.equal(analysis.schema, 1); assert.equal(analysis.codec, 'h264');
      assert.ok(analysis.blocks > 0); assert.equal(analysis.after, analysis.before, 'local analysis leaves playback in place');
    }
    const markId = await page.evaluate(() => window.voidPlayer.addMark({ slot: 'A', text: 'Sites local mark' }).id);
    await page.locator('#toggle-sources').click();
    await page.locator('#local-source-search').fill('ci ');
    assert.equal(await page.locator('#local-source-search').inputValue(), 'ci ', 'typing a multiword query preserves spaces');
    await page.locator('#local-source-search').fill('no-match');
    assert.equal(await page.locator('#source-list .source-row').count(), 0);
    await page.locator('#local-source-search').fill('ci_h264');
    assert.equal(await page.locator('#source-list .source-row').count(), 1);
    assert.equal(await page.locator('#library-manage, #library-mounts').count(), 0);
    assert.equal(await page.locator('#local-add').isVisible(), true);
    await page.locator('#settings-open').click();
    await page.locator('#settings-tab-workspace').click();
    assert.equal(await page.locator('#local-workspace-export, #checkpoint-history-list, #saved-workspace-save').count(), 0);
    const state = await page.evaluate(() => window.voidPlayer.exportState());
    assert.equal(state.abi, 1); assert.equal(state.tracks[0].local.name, first.name);
    assert.equal(state.layout.sources.search, 'ci_h264');
    await page.locator('#settings-close').click();
    await page.evaluate(() => window.voidPlayer.setViewport({ channel: 'y', zoom: 2 }));
    await page.evaluate(state => window.voidPlayer.applyState(state), state);
    assert.equal(await page.evaluate(() => window.voidPlayer.getViewport().channel), state.viewport.channel);
    assert.ok(await page.evaluate(id => window.voidPlayer.getState().marks.some(mark => mark.id === id), markId));
    await page.waitForFunction(() => new URL(location.href).searchParams.has('A'));
    await page.screenshot({ path: path.join(evidence, isolated ? 'isolated.png' : 'static.png') });
    const remote = await page.evaluate(async state => {
      try {
        await window.voidPlayer.applyState({ ...state, tracks: [{ slot: 'A', id: 'a'.repeat(24), version: 'b'.repeat(24), offsetUs: 0, visible: true }] });
        return { rejected: false };
      } catch { return { rejected: true, marks: window.voidPlayer.getState().marks.map(mark => mark.id) }; }
    }, state);
    assert.equal(remote.rejected, true, 'the build profile rejects remote URI sources before any request');
    assert.ok(remote.marks.includes(markId));
    // Real packet WASM and the FFmpeg container/FileReaderSync path both work without isolation.
    const decoders = [];
    for (const file of [software, avi]) {
      console.log('RUN Sites ' + engine + ' isolated=' + isolated + ' ' + path.basename(file));
      await page.evaluate(() => window.voidPlayer.removeTrack('A'));
      await page.locator('#file-A').setInputFiles(file);
      await page.waitForFunction(() => !window.voidPlayer.getState().busy && window.voidPlayer.getState().tracks[0]?.frame);
      const track = await page.evaluate(() => window.voidPlayer.getState().tracks[0]);
      assert.equal(track.decoder, 'ffmpeg-wasm');
      if (!isolated) assert.equal(track.coreVariant, 'single-thread');
      await page.evaluate(() => window.voidPlayer.step(1));
      decoders.push({ name: track.name, decoder: track.decoder, coreVariant: track.coreVariant });
    }
    await page.waitForTimeout(1200); // One local sync tick must also stay off the network.
    assert.deepEqual(apiRequests, [], 'no startup, UI, restore or background task calls /api/');
    assert.deepEqual(failures, [], 'no browser exceptions');
    rows.push({ isolated, decoders, uriState: true, annotation: true, apiRequests: 0 });
    await context.close();
    console.log('PASS Sites ' + engine + ' isolated=' + isolated);
  }
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    const failure = await page.evaluate(async () => ({ state: window.voidPlayer?.getState(), log: await window.voidPlayer?.exportLog() })).catch(() => null);
    await writeFile(path.join(evidence, 'failure.json'), JSON.stringify(failure, null, 2));
  }
  throw error;
} finally {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ engine, rows, apiRequests, failures }, null, 2) + '\n');
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
