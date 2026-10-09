// Actual AAC/Opus output + equal media IO with the speaker off/on.
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
const container = process.env.AUDIO_CONTAINER ?? 'flv';
const local = process.env.AUDIO_INPUT === 'local';
const extension = ['faststart', 'fragmented'].includes(container) ? 'mp4' : container;
assert.ok(['flv', 'mp4', 'faststart', 'fragmented', 'ts', 'mkv', 'webm'].includes(container));
assert.ok(['chromium', 'webkit'].includes(browserName));
const temporary = await mkdtemp(path.join(tmpdir(), 'voidplayer-audio-'));
const artifacts = path.join(root, '.run/opportunistic-audio', container + (local ? '-local' : '')); await mkdir(artifacts, { recursive: true });
let browser, server, library, activePage, evidence, tracing = false;
try {
  const media = path.join(temporary, 'media'); await mkdir(media);
  const fixture = path.join(media, 'audio.flv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '30', '-bf', '0', '-b:v', '700k', '-c:a', 'aac', '-b:a', '128k', '-y', fixture]);
  const selected = container === 'flv' ? fixture : path.join(media, `audio.${extension}`);
  if (container !== 'flv') execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fixture,
    ...(container === 'webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'] : ['-c', 'copy']),
    ...(container === 'faststart' ? ['-movflags', '+faststart'] : container === 'fragmented' ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : []), '-y', selected]);
  await copyFile(selected, path.join(media, `second.${extension}`));
  library = new MediaLibraryIndex([media], { database: path.join(temporary, 'library.sqlite'), watch: false });
  const listing = await library.list();
  const id = listing.entries.find(e => e.name === `audio.${extension}`).id;
  const second = listing.entries.find(e => e.name === `second.${extension}`).id;
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
      window.audioBlobReads = [];
      window.audioEvidence = { contexts: 0, starts: 0, stopped: 0, maxRms: 0, live: new Set() };
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(...args) { super(...args); window.audioEvidence.contexts++; }
        createBufferSource() {
          const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node);
          node.start = (...args) => {
            const samples = node.buffer?.getChannelData(0);
            if (samples?.length) window.audioEvidence.maxRms = Math.max(window.audioEvidence.maxRms, Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length));
            window.audioEvidence.starts++; window.audioEvidence.live.add(node);
            if (window.audioSwitch && window.voidPlayer.getState().audioSlot !== 'B') window.audioSwitch.wrongSlotStarts++;
            return start(...args); };
          node.stop = (...args) => { window.audioEvidence.stopped++; window.audioEvidence.live.delete(node); return stop(...args); };
          node.addEventListener('ended', () => window.audioEvidence.live.delete(node)); return node;
        }
      };
    });
    await page.context().route(/\/assets\/(?:ffmpeg|packet)-worker-[^/]+\.js$/, async route => {
      const response = await route.fetch();
      const prefix = `if (typeof self.FileReaderSync !== 'undefined') { const NativeReader = self.FileReaderSync; self.FileReaderSync = class extends NativeReader { readAsArrayBuffer(blob) { self.postMessage({type:'audio-test-blob-read', bytes:blob.size}); return super.readAsArrayBuffer(blob); } }; } const blobRead = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function() { self.postMessage({type:'audio-test-blob-read', bytes:this.size}); return blobRead.call(this); };\n`;
      await route.fulfill({ response, body: prefix + await response.text() });
    });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker { constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.type === 'audio-test-blob-read') window.audioBlobReads.push(e.data.bytes); }); } };
    });
    traffic = [];
    await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
    if (local) { await page.locator('#file-A').setInputFiles(selected); await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy); }
    else await tool(page, 'load_library_item', { id, slot: 'A' });
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
    if (enabled) await page.waitForFunction(() => window.audioEvidence.starts > 0, undefined, { timeout: 10000 });
    await tool(page, 'seek_review', { ptsUs: 1500000 });
    assert.equal(await page.evaluate(() => window.audioEvidence.live.size), 0, 'seek stops old audio before returning');
    await page.locator('#play').click();
    await page.waitForFunction(() => { const s = window.voidPlayer.tools.find(t => t.name === 'get_review_session').execute({}); return !s.playing && s.positionUs > 2500000; });
    const result = await state(page);
    const audioEvidence = await page.evaluate(() => ({ ...window.audioEvidence, live: window.audioEvidence.live.size }));
    if (enabled) { assert.ok(audioEvidence.starts > 0); assert.ok(audioEvidence.maxRms > 0.01, 'decoded PCM contains the fixture tone'); } else assert.equal(audioEvidence.starts, 0);
    assert.equal(audioEvidence.live, 0, 'end of video stops audio');
    assert.deepEqual(errors, []);
    report.push({ enabled, blobReads: await page.evaluate(() => window.audioBlobReads), traffic: [...traffic], audio: audioEvidence, video: { positionUs: result.positionUs, durationUs: result.durationUs, error: result.error } });
    if (enabled) {
      await tool(page, 'load_library_item', { id: second, slot: 'B' });
      await tool(page, 'seek_review', { ptsUs: 0 }); await page.locator('#play').click();
      const beforeSwitch = await page.evaluate(() => window.audioEvidence.starts);
      await page.waitForFunction(before => window.audioEvidence.starts > before, beforeSwitch);
      const secondSpeaker = page.locator('.subtrack-row[data-track-drag="B"] .track-audio');
      // Snapshot node identities in capture phase, immediately before the real UI
      // handler. Check again in bubble phase: a later Playwright round trip can
      // already see valid B nodes, and must not mistake them for surviving A nodes.
      await secondSpeaker.evaluate(button => {
        button.addEventListener('click', () => {
          const old = new Set(window.audioEvidence.live);
          window.audioSwitch = { oldCount: old.size, survivors: null, stopped: 0, wrongSlotStarts: 0 };
          const stopped = window.audioEvidence.stopped;
          document.addEventListener('click', () => {
            window.audioSwitch.survivors = [...old].filter(node => window.audioEvidence.live.has(node)).length;
            window.audioSwitch.stopped = window.audioEvidence.stopped - stopped;
          }, { once: true });
        }, { capture: true, once: true });
      });
      // Switch in the same browser task that observes live A nodes. A protocol
      // round trip/actionability wait can outlive these ~21 ms buffers. A has
      // already unlocked the AudioContext with a trusted speaker click above.
      await page.waitForFunction(() => {
        if (!window.audioEvidence.live.size) return false;
        document.querySelector('.subtrack-row[data-track-drag="B"] .track-audio').click();
        return true;
      });
      const switched = await page.evaluate(() => window.audioSwitch);
      assert.ok(switched.oldCount > 0, 'switch exercised live old-track nodes');
      assert.equal(switched.survivors, 0, 'switching synchronously stops all old nodes');
      assert.ok(switched.stopped >= switched.oldCount, 'old nodes are stopped, not merely naturally ended');
      assert.equal((await state(page)).audioSlot, 'B');
      assert.equal(await speaker.getAttribute('aria-pressed'), 'false');
      await tool(page, 'reorder_review_tracks', { order: ['B', 'A'] }); assert.equal((await state(page)).audioSlot, 'B');
      await page.waitForFunction(() => window.voidPlayer.getState().audioPacketsPlayed > 0);
      assert.equal(await page.evaluate(() => window.audioSwitch.wrongSlotStarts), 0, 'only the selected track starts nodes after switching');
      await tool(page, 'pause_review');
      assert.equal(await page.evaluate(() => window.audioEvidence.live.size), 0, 'pause stops the new track too');
      report[1].switch = switched;
      if (container === 'flv' && !local) await page.screenshot({ path: path.join(artifacts, 'speaker-panel.png') });
      await tool(page, 'remove_review_track', { slot: 'B' }); assert.equal((await state(page)).audioSlot, null);
      // Keep navigation tracing on failure: worker teardown and load-blocking
      // requests must be diagnosable without retrying or extending the timeout.
      await page.context().tracing.start({ snapshots: true }); tracing = true;
      await page.reload(); await page.waitForFunction(() => window.voidPlayer);
      await page.context().tracing.stop(); tracing = false;
      assert.equal((await state(page)).audioSlot, null, 'audio selection is never persisted');
    }
    await page.close();
  }
  // The complete clip fits the video cache. Both runs use the same seek sequence.
  if (!local) assert.ok(report[0].traffic.length > 0, 'the control must measure real media Range traffic');
  if (local) assert.ok(report[0].blobReads.length, 'local control observes actual Blob IO');
  assert.deepEqual(report[1].blobReads, report[0].blobReads, 'speaker adds zero local Blob reads');
  assert.deepEqual(report[1].traffic, report[0].traffic, 'speaker adds zero media requests and bytes');
  await writeFile(path.join(artifacts, `${browserName}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ container, local, report })); console.log('PASS default mute, decoded audio, seek, single slot, button geometry, restore and identical media IO');
} catch (error) {
  if (tracing) await activePage.context().tracing.stop({ path: path.join(artifacts, `${browserName}-navigation.zip`) }).catch(() => {});
  await saveBrowserFailure({ page: activePage, directory: artifacts, name: browserName,
    context: { caseName: 'opportunistic-audio', engine: browserName }, error, evidence });
  throw error;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await library?.close(); await rm(temporary, { recursive: true, force: true });
}
