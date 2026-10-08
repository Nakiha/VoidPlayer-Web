// Actual AAC output + equal video Range traffic with the speaker off/on.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { saveBrowserFailure, recordBrowserEvidence } from './browser-failure-evidence.mjs';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';
const root = path.resolve(import.meta.dirname, '..');
const browserName = process.argv[2] ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const temporary = await mkdtemp(path.join(tmpdir(), 'voidplayer-audio-'));
const artifacts = path.join(root, '.run/opportunistic-audio'); await mkdir(artifacts, { recursive: true });
let browser, server, library, activePage, evidence;
try {
  const media = path.join(temporary, 'media'); await mkdir(media);
  const fixture = path.join(media, 'audio.flv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '30', '-bf', '0', '-b:v', '700k', '-c:a', 'aac', '-b:a', '128k', '-y', fixture]);
  await copyFile(fixture, path.join(media, 'second.flv'));
  library = new MediaLibraryIndex([media], { database: path.join(temporary, 'library.sqlite'), watch: false });
  const listing = await library.list();
  const id = listing.entries.find(e => e.name === 'audio.flv').id;
  const second = listing.entries.find(e => e.name === 'second.flv').id;
  let traffic = [];
  server = createMediaServer({ roots: library.roots, library, staticDir: path.join(root, 'dist'), onLog() {} });
  server.on('request', (req, res) => {
    if (req.url.split('?')[0] === `/api/media/${id}` || req.url.split('?')[0] === `/api/media/${second}`) {
      res.on('finish', () => traffic.push({ range: req.headers.range, bytes: Number(res.getHeader('content-length')) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true,
    ...(browserName === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
    ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
  const report = [];
  async function tool(page, name, input = {}) { return page.evaluate(({ name, input }) => window.voidPlayer.tools.find(t => t.name === name).execute(input), { name, input }); }
  async function state(page) { return tool(page, 'get_review_session'); }
  for (const enabled of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    activePage = page; evidence = recordBrowserEvidence(page);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    // Count actual output nodes and verify a pause/mute immediately stops all of them.
    await page.addInitScript(() => {
      localStorage.setItem('voidplayer.color-mode', 'browser');
      window.audioEvidence = { contexts: 0, starts: 0, stopped: 0, maxRms: 0, live: new Set() };
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(...args) { super(...args); window.audioEvidence.contexts++; }
        createBufferSource() {
          const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node);
          node.start = (...args) => {
            const samples = node.buffer?.getChannelData(0);
            if (samples?.length) window.audioEvidence.maxRms = Math.max(window.audioEvidence.maxRms, Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length));
            window.audioEvidence.starts++; window.audioEvidence.live.add(node); return start(...args); };
          node.stop = (...args) => { window.audioEvidence.stopped++; window.audioEvidence.live.delete(node); return stop(...args); };
          node.addEventListener('ended', () => window.audioEvidence.live.delete(node)); return node;
        }
      };
    });
    traffic = [];
    await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
    await tool(page, 'load_library_item', { id, slot: 'A' });
    if (await page.locator('#toggle-subtracks').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-subtracks').click();
    const speaker = page.locator('.subtrack-row[data-track-drag="A"] .track-audio');
    assert.equal(await speaker.getAttribute('aria-pressed'), 'false');
    assert.equal((await state(page)).audioSlot, null);
    assert.equal(await page.evaluate(() => window.audioEvidence.contexts), 0);
    const positions = await page.locator('.subtrack-row[data-track-drag="A"]').evaluate(row => {
      const speaker = row.querySelector('.track-audio').getBoundingClientRect(), eye = row.querySelector('.track-visibility').getBoundingClientRect();
      return { speakerRight: speaker.right, eyeLeft: eye.left };
    });
    assert.ok(positions.speakerRight <= positions.eyeLeft, 'speaker is immediately left of visibility');
    if (enabled) { await speaker.click(); assert.equal((await state(page)).audioSlot, 'A'); }
    await page.locator('#play').click();
    await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_review_session').execute({}).positionUs > 800000);
    if (enabled) {
      await page.waitForFunction(() => window.audioEvidence.starts > 0, undefined, { timeout: 10000 });
      await tool(page, 'seek_review', { ptsUs: 1500000 });
      assert.equal(await page.evaluate(() => window.audioEvidence.live.size), 0, 'seek stops old audio before returning');
      await page.locator('#play').click();
    }
    await page.waitForFunction(() => { const s = window.voidPlayer.tools.find(t => t.name === 'get_review_session').execute({}); return !s.playing && s.positionUs > 2500000; });
    const result = await state(page);
    const audioEvidence = await page.evaluate(() => ({ ...window.audioEvidence, live: window.audioEvidence.live.size }));
    if (enabled) { assert.ok(audioEvidence.starts > 0); assert.ok(audioEvidence.maxRms > 0.01, 'decoded PCM contains the fixture tone'); } else assert.equal(audioEvidence.starts, 0);
    assert.equal(audioEvidence.live, 0, 'end of video stops audio');
    assert.deepEqual(errors, []);
    report.push({ enabled, traffic: [...traffic], audio: audioEvidence, video: { positionUs: result.positionUs, durationUs: result.durationUs, error: result.error } });
    if (enabled) {
      await tool(page, 'load_library_item', { id: second, slot: 'B' });
      await tool(page, 'seek_review', { ptsUs: 0 }); await page.locator('#play').click();
      const beforeSwitch = await page.evaluate(() => window.audioEvidence.starts);
      await page.waitForFunction(before => window.audioEvidence.starts > before, beforeSwitch);
      await page.locator('.subtrack-row[data-track-drag="B"] .track-audio').click();
      assert.equal(await page.evaluate(() => window.audioEvidence.live.size), 0, 'switching stops all old nodes');
      assert.equal((await state(page)).audioSlot, 'B');
      assert.equal(await speaker.getAttribute('aria-pressed'), 'false');
      await tool(page, 'reorder_review_tracks', { order: ['B', 'A'] }); assert.equal((await state(page)).audioSlot, 'B');
      await page.waitForFunction(() => window.voidPlayer.getState().audioPacketsPlayed > 0);
      await tool(page, 'pause_review');
      await page.screenshot({ path: path.join(artifacts, 'speaker-panel.png') });
      await tool(page, 'remove_review_track', { slot: 'B' }); assert.equal((await state(page)).audioSlot, null);
      await page.reload(); await page.waitForFunction(() => window.voidPlayer);
      assert.equal((await state(page)).audioSlot, null, 'audio selection is never persisted');
    }
    await page.close();
  }
  // The complete clip fits the existing video cache. The enabled run also seeks,
  // but may not issue an extra request for any already-read audio byte.
  assert.ok(report[0].traffic.length > 0, 'the control must measure real media Range traffic');
  assert.deepEqual(report[1].traffic, report[0].traffic, 'speaker adds zero media requests and bytes');
  await writeFile(path.join(artifacts, `${browserName}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); console.log('PASS default mute, AAC output, seek, single slot, button geometry, restore and identical Range traffic');
} catch (error) {
  await saveBrowserFailure({ page: activePage, directory: artifacts, name: browserName,
    context: { caseName: 'opportunistic-audio', engine: browserName }, error, evidence });
  throw error;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await library?.close(); await rm(temporary, { recursive: true, force: true });
}
