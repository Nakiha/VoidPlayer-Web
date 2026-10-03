// Local Blob and HTTP Range exercise the same opening policy and real core.
// Synthetic long TS is deliberate: seek work must follow GOP size, not time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';

const root = await mkdtemp(path.join(tmpdir(), 'vp-containers-'));
const engine = process.argv[2] ?? 'chromium';
let library, server, browser;
try {
  const encode = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 60000 });
  encode(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '70', '-an',
    '-c:v', 'mpeg2video', '-threads', '2', '-g', '12', '-bf', '2', '-b:v', '4M',
    '-muxrate', '16000000', '-f', 'mpegts', path.join(root, 'mpeg2.ts')]);
  encode(['-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=25', '-t', '3', '-an',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '25', '-bf', '0',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', path.join(root, 'h264.mp4')]);
  encode(['-i', path.join(root, 'h264.mp4'), '-c', 'copy', '-f', 'mpegts', path.join(root, 'h264.ts')]);
  // The misleading suffix must not send local TS through Mp4Engine.
  await copyFile(path.join(root, 'mpeg2.ts'), path.join(root, 'renamed.mp4'));
  library = new MediaLibraryIndex([root], { watch: false }); await library.refresh();
  server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
    ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  for (const [name, local, software] of [
    ['renamed.mp4', true, false], ['mpeg2.ts', false, false],
    ['h264.ts', true, false], ['h264.ts', false, false],
    ['h264.mp4', true, false], ['h264.mp4', false, false],
    ['h264.ts', true, true], ['h264.ts', false, true],
  ]) {
    const context = await browser.newContext({locale:'zh-CN'}), page = await context.newPage(), errors = [], requests = [];
    let libraryEntryId;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/media\/[0-9a-f]+$/.test(new URL(r.url()).pathname)) requests.push(r.headers()); });
    if (!local && name === 'mpeg2.ts') await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.__voidPlayerIndexStreams = [];
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const input = args[0];
        const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname.endsWith('/frame-index') && response.headers.get('content-type')?.includes('application/x-ndjson')) {
          const capture = { url: url.href, events: [], done: false, error: null };
          window.__voidPlayerIndexStreams.push(capture);
          void response.clone().text().then(body => {
            capture.events = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            capture.done = true;
          }).catch(error => { capture.error = String(error); });
        }
        return response;
      };
    });
    await page.addInitScript(software => {
      localStorage.setItem('voidplayer.color-mode', software ? 'reference' : 'browser');
      localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ decoder: software ? 'software' : 'hardware', depth: 2 }));
    }, software);
    try {
      await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
      const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
      if (local) {
        await page.locator('#file-A').setInputFiles(path.join(root, name));
        await page.waitForFunction(() => !window.voidPlayer.getState().busy && window.voidPlayer.getState().tracks[0]?.frame, null, { timeout: 60000 });
      } else {
        const listing = await call('list_library');
        const entry = listing.entries.find(e => e.name === name);
        assert.ok(entry, `library fixture ${name} is listed`);
        libraryEntryId = entry.id;
        await call('load_library_item', { id: libraryEntryId, slot: 'A' });
      }
      const first = await call('get_review_session'), long = name === 'mpeg2.ts' || name === 'renamed.mp4';
      if (!local && name === 'mpeg2.ts') {
        assert.equal(first.error, null);
        assert.equal(first.tracks[0].indexSource, 'server', 'cold FFmpeg library index must import from the server');
        assert.ok(first.tracks[0].frame, 'the first presentable frame is returned independently of index finality');
        await page.waitForFunction(() => window.__voidPlayerIndexStreams?.some(stream =>
          stream.error || stream.events.some(event => event.type === 'complete' || event.type === 'error')),
        null, { timeout: 180000 });
        const indexEvents = await page.evaluate(() => {
          const streams = window.__voidPlayerIndexStreams;
          const stream = streams.find(item => item.events.some(event => event.type === 'complete')) ?? streams.at(-1);
          if (stream?.error) throw new Error(stream.error);
          return stream?.events ?? [];
        });
        assert.ok(indexEvents.some(event => event.type === 'complete'), 'cold FFmpeg index stream reaches completion');
        const manifestAt = indexEvents.findIndex(event => event.type === 'manifest' && event.protocol === 2);
        const scanPositions = indexEvents.map((event, index) => event.type === 'progress' && event.phase === 'scan' ? index : -1).filter(index => index >= 0);
        const batches = indexEvents.filter(event => event.type === 'batch');
        const completeAt = indexEvents.findIndex(event => event.type === 'complete');
        const batchPositions = indexEvents.map((event, index) => event.type === 'batch' ? index : -1).filter(index => index >= 0);
        assert.ok(manifestAt >= 0 && scanPositions.length > 0 && scanPositions[0] > manifestAt,
          'cold record stream must report demux scan progress');
        assert.ok(batchPositions.length > 0 && Math.max(...scanPositions) < Math.min(...batchPositions),
          'full MPEG-TS scan progress must finish before completed-index batches are published');
        assert.ok(completeAt > Math.max(...batchPositions), 'the finality event follows every imported batch');
        assert.ok(batches.length > 0 && batches.every(event => event.buildId === indexEvents[manifestAt].buildId
          && Number.isSafeInteger(event.count) && event.count > 0
          && Number.isSafeInteger(event.safePresentationUs)), 'record batches carry one build identity and a stable coverage watermark');
        assert.deepEqual(batches.map(event => event.seq), batches.map((_, index) => index), 'all batches belong to one contiguous build');
        assert.deepEqual(batches.map(event => event.safePresentationUs),
          batches.map(event => event.safePresentationUs).toSorted((a, b) => a - b), 'coverage advances monotonically as final records import');
        assert.equal(batches.reduce((sum, event) => sum + event.count, 0), indexEvents[completeAt].frames,
          'all scanned records arrive before index finality');
        assert.equal(batches[batches.length - 1].seq, indexEvents[completeAt].lastSeq);
        await page.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.indexState === 'complete', null, { timeout: 60000 });
        const coldLogs = await call('get_review_logs', { limit: 500 });
        const coldTrace = coldLogs.events.filter(event => event.msg === '媒体管线追踪').map(event => event.data);
        const firstFrameAt = coldTrace.findIndex(event => event.phase === 'first-frame-ready');
        const indexCompleteAt = coldTrace.findIndex(event => event.phase === 'index-complete');
        assert.ok(firstFrameAt >= 0 && indexCompleteAt > firstFrameAt,
          'first-frame readiness precedes index finality, without requiring scan-time seek coverage');
        await call('remove_review_track', { slot: 'A' });
        await call('load_library_item', { id: libraryEntryId, slot: 'A' });
        const warm = await call('get_review_session');
        assert.equal(warm.error, null);
        assert.equal(warm.tracks[0].indexSource, 'server', 'warm FFmpeg cache must import without client-side index_build');
      }
      assert.equal(first.error, null);
      assert.equal(first.tracks[0].container, name === 'h264.mp4' ? 'isobmff' : 'mpegts');
      const usesFfmpegDecoder = first.tracks[0].decoder === 'ffmpeg-wasm';
      if (long || software || usesFfmpegDecoder) await page.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.indexState === 'complete', null, { timeout: 60000 });
      const final = await call('get_review_session');
      assert.equal(final.error, null);
      if (long || software || usesFfmpegDecoder) {
        assert.equal(final.tracks[0].decoder, 'ffmpeg-wasm');
        assert.equal(final.tracks[0].indexState, 'complete');
        assert.equal(final.tracks[0].seekStrategy, 'demuxer-keyframe');
        assert.ok(final.tracks[0].seekAnchorCount > 0);
      } else if (name === 'h264.mp4') assert.equal(first.tracks[0].decoder, 'webcodecs', 'supported H.264 MP4 uses native decode');
      else assert.equal(first.tracks[0].decoder, 'ffmpeg-wasm', 'MPEG-TS uses the FFmpeg container/decode fallback for H.264');
      const timings = [];
      for (const ptsUs of long ? [10e6, 36e6, 64e6, 10e6, 0] : [1e6, 2e6, 0]) {
        const start = performance.now(); await call('seek_review', { ptsUs });
        timings.push(Math.round(performance.now() - start));
        const state = await call('get_review_session');
        assert.equal(state.error, null); assert.equal(state.tracks[0].frame.ptsUs, ptsUs);
      }
      const logs = await call('get_review_logs', { limit: 500 });
      assert.ok(logs.events.some(e => e.msg === '媒体适配器选择' && e.data.software === (name === 'h264.mp4' ? 'packet-mp4' : 'ffmpeg-container')));
      if (!local && name === 'mpeg2.ts') {
        const ready = logs.events.filter(e => e.msg === 'WASM core 已就绪').map(e => e.data);
        assert.ok(ready.length >= 2, 'cold and warm server-index opens are observed');
        assert.ok(ready.slice(-2).every(e => e.indexSource === 'server' && e.localIndexBuildCalls === 0), JSON.stringify(ready.slice(-2)));
      }
      assert.ok(!logs.events.some(e => /MP4 压缩包路径不可用/.test(e.msg)), 'TS never attempts the MP4 packet adapter');
      if (long) {
        const seeks = logs.events.filter(e => e.msg === 'WASM 帧定位完成').map(e => e.data);
        assert.ok(seeks.length >= 4, 'each random seek records bounded work');
        for (const seek of seeks) { assert.equal(seek.restarts, 0); assert.ok(seek.decodedFrames <= 30, JSON.stringify(seek)); }
        console.log(`TS WORK ${JSON.stringify({ local, timings, seeks })}`);
      }
      if (!local) assert.ok(requests.length && requests.every(r => /^bytes=/.test(r.range ?? '')), 'remote reads are Range requests');
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: ${name} ${local ? 'local' : 'remote'} ${software ? 'software reference' : 'browser'} -> ${first.tracks[0].decoder}`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await library?.close(); await rm(root, { recursive: true, force: true });
}
