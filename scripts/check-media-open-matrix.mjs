// Characterize media/index selection across color and decoder modes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';

const root = path.resolve('.');
const generated = await mkdtemp(path.join(tmpdir(), 'vp-media-open-matrix-'));
const openGop = path.join(generated, 'hevc-open-gop.mp4');
const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
if (!encoders.includes('libx265')) throw new Error('The media-open matrix requires the FFmpeg libx265 encoder for its open-GOP MP4 fixture.');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '2', '-an',
  '-c:v', 'libx265', '-threads', '1', '-preset', 'ultrafast', '-g', '25', '-bf', '3',
  '-x265-params', 'pools=1:frame-threads=1:log-level=error:open-gop=1:keyint=25:min-keyint=25', '-tag:v', 'hvc1', openGop], { timeout: 30000 });

const fixtures = [
  { name: 'standard-h264.flv', container: 'flv', codec: 'H264', path: 'fixtures/flv/standard-h264.flv' },
  { name: 'enhanced-hevc.flv', container: 'flv', codec: 'HEVC', path: 'fixtures/flv/enhanced-hevc.flv' },
  { name: 'h264_9s_1920x1080.mp4', container: 'mp4', codec: 'H264', path: 'fixtures/video/h264_9s_1920x1080.mp4' },
  { name: 'h265_10s_1920x1080.mp4', container: 'mp4', codec: 'HEVC', path: 'fixtures/video/h265_10s_1920x1080.mp4' },
  { name: 'hevc-open-gop.mp4', container: 'mp4', codec: 'HEVC open-GOP', path: openGop },
  { name: 'mpegts--h264small.ts', container: 'mpegts', codec: 'H264', path: 'fixtures/fate/mpegts--h264small.ts' },
  { name: 'mpegts--loewe.ts', container: 'mpegts', codec: 'HEVC', path: 'fixtures/fate/mpegts--loewe.ts' },
  { name: 'h266_10s_1920x1080.mp4', container: 'mp4', codec: 'VVC', path: 'fixtures/video/h266_10s_1920x1080.mp4' },
].map(fixture => ({ ...fixture, path: path.resolve(fixture.path) }));

const library = new MediaLibraryIndex([
  path.join(root, 'fixtures/flv'), path.join(root, 'fixtures/video'), path.join(root, 'fixtures/fate'), generated,
], { watch: false });
const server = createMediaServer({ library, roots: library.roots, staticDir: path.join(root, 'dist'), onLog() {} });
let browser;
await library.refresh();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const engine = process.argv[2] ?? 'webkit';
  browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true,
    ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];

  async function openCase(fixture, colorMode, decoder) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], indexRequests = [], indexGetRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.endsWith('/frame-index')) {
        indexRequests.push({ method: request.method(), url: request.url() });
        if (request.method() === 'GET') indexGetRequests.push(request.url());
      }
    });
    await page.addInitScript(({ colorMode, decoder }) => {
      localStorage.setItem('voidplayer.color-mode', colorMode);
      localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ decoder, depth: 2 }));
    }, { colorMode, decoder });
    try {
      await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
      const call = (name, args = {}) => page.evaluate(({ name, args }) => {
        const tool = window.voidPlayer.tools.find(item => item.name === name);
        if (!tool) throw new Error('Missing tool: ' + name);
        return tool.execute(args);
      }, { name, args });
      const listing = await call('list_library', { search: fixture.name });
      const entry = listing.entries.find(item => item.name === fixture.name);
      assert.ok(entry, `Missing fixture in library: ${fixture.name}`);
      await call('load_library_item', { id: entry.id, slot: 'A' });
      await page.waitForFunction(() => { const state = window.voidPlayer.getState(); return !state.busy && !!state.tracks[0]?.frame; }, null, { timeout: 60000 });
      // A distant target forces a progressive source to resolve full coverage
      // before this comparison records final timeline values.
      await call('seek_review', { ptsUs: 1_000_000_000 });
      await call('seek_review', { ptsUs: 0 });
      const state = await call('get_review_session');
      const logs = await call('get_review_logs', { limit: 2000 });
      const trace = logs.events.filter(event => event.msg === '媒体管线追踪').map(event => event.data);
      assert.ok(trace.some(event => event?.phase === 'first-frame-ready'), `Missing first-frame trace for ${fixture.name} / ${colorMode} / ${decoder}`);
      if (fixture.container === 'flv') {
        assert.equal(indexGetRequests.length, 1, `${fixture.name} / ${colorMode} / ${decoder}: one FLV index subscriber per open`);
        assert.ok(trace.filter(event => event?.phase === 'container-selected').every(event => event.demuxBackend === 'flv-engine'),
          `${fixture.name} / ${colorMode} / ${decoder}: FLV demux backend must stay shared`);
        if (colorMode === 'reference' && decoder === 'hardware') {
          const firstReady = trace.find(event => event?.phase === 'first-frame-ready');
          assert.equal(firstReady?.softwareOpenCount, 0, `${fixture.name}: reference witness must not open a second software source`);
        }
      }
      assert.deepEqual(errors, [], `${fixture.name} / ${colorMode} / ${decoder}: ${errors.join('; ')}`);
      const result = {
        fixture: fixture.name, expectedContainer: fixture.container, expectedCodec: fixture.codec,
        colorMode, decoderPreference: decoder, mediaId: entry.id, mediaVersion: entry.version,
        decoderBackend: state.tracks[0].decoder, firstPtsUs: state.tracks[0].firstPtsUs,
        durationUs: state.tracks[0].durationUs, stableCoverageUs: state.tracks[0].stableCoverageUs,
        indexState: state.tracks[0].indexState, indexSource: state.tracks[0].indexSource,
        seekAnchorCount: state.tracks[0].seekAnchorCount, indexRequests, indexGetRequests,
        trace: trace.map(event => Object.fromEntries(['phase', 'mediaId', 'mediaVersion', 'container', 'demuxBackend', 'indexBackend',
          'indexIdentity', 'indexBuildId', 'serverIndexRequests', 'firstIndexBatchMs', 'indexCompleteMs', 'decoderBackend', 'colorMode',
          'firstPtsUs', 'durationUs', 'stableCoverageUs', 'seekAnchorCount', 'firstFrameReadyMs', 'nativeOpenCount', 'softwareOpenCount']
          .filter(key => key in event).map(key => [key, event[key]]))),
      };
      results.push(result);
      console.log(JSON.stringify(result));
      return result;
    } finally { await context.close(); }
  }

  for (const fixture of fixtures) {
    await openCase(fixture, 'browser', 'hardware');
    await openCase(fixture, 'reference', 'hardware');
    await openCase(fixture, 'reference', 'software');
  }
  const modeComparisons = fixtures.map(fixture => {
    const cases = results.filter(result => result.fixture === fixture.name);
    const firstFrames = cases.map(result => result.trace.find(event => event.phase === 'first-frame-ready'));
    return {
      fixture: fixture.name,
      paths: cases.map((result, index) => {
        const valueFor = key => result.trace.find(event => event[key] != null)?.[key];
        return { mode: `${result.colorMode}/${result.decoderPreference}`, demuxBackend: firstFrames[index]?.demuxBackend,
          indexBackend: firstFrames[index]?.indexBackend, decoderBackend: result.decoderBackend,
          indexIdentity: valueFor('indexIdentity'), indexBuildId: valueFor('indexBuildId'),
          firstPtsUs: result.firstPtsUs, durationUs: result.durationUs, stableCoverageUs: result.stableCoverageUs,
          softwareOpenCount: firstFrames[index]?.softwareOpenCount,
          serverIndexRequests: result.indexRequests.length };
      }),
      sameTimeline: cases.every(result => result.firstPtsUs === cases[0].firstPtsUs && result.durationUs === cases[0].durationUs),
    };
  });
  for (const comparison of modeComparisons) {
    assert.equal(comparison.sameTimeline, true, `${comparison.fixture}: browser and reference timelines must match`);
    assert.equal(new Set(comparison.paths.map(path => path.demuxBackend)).size, 1,
      `${comparison.fixture}: decoder/color preferences must keep one container plan (${comparison.paths.map(path => path.demuxBackend).join(', ')})`);
    if (fixtures.find(fixture => fixture.name === comparison.fixture)?.container === 'flv') {
      assert.ok(comparison.paths.every(path => path.demuxBackend === 'flv-engine'), `${comparison.fixture}: all modes share FlvEngine`);
    }
  }
  console.log(JSON.stringify({ phase: 'mode-matrix-comparison', cases: modeComparisons }));

  // Capture the existing mode-switch request path on the same versioned item.
  for (const fixture of [fixtures.find(item => item.name === 'h264_9s_1920x1080.mp4'), fixtures.find(item => item.name === 'mpegts--h264small.ts')]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const indexRequests = [];
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/frame-index')) indexRequests.push(request.url()); });
    await page.addInitScript(() => localStorage.setItem('voidplayer.color-mode', 'browser'));
    try {
      await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
      const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(item => item.name === name).execute(args), { name, args });
      const entry = (await call('list_library', { search: fixture.name })).entries.find(item => item.name === fixture.name);
      await call('load_library_item', { id: entry.id, slot: 'A' });
      await page.waitForFunction(() => !window.voidPlayer.getState().busy && !!window.voidPlayer.getState().tracks[0]?.frame);
      const indexRequestsBeforeSwitch = indexRequests.length;
      const transitions = [];
      for (const mode of ['reference', 'browser']) {
        await call('set_review_color_mode', { mode });
        await page.waitForFunction(() => !window.voidPlayer.getState().busy && !!window.voidPlayer.getState().tracks[0]?.frame);
        const current = await call('get_review_session');
        transitions.push({ mode, firstPtsUs: current.tracks[0].firstPtsUs, durationUs: current.tracks[0].durationUs, decoder: current.tracks[0].decoder });
      }
      const logs = await call('get_review_logs', { limit: 2000 });
      const traceFields = ['phase', 'mediaId', 'mediaVersion', 'container', 'demuxBackend', 'indexBackend', 'indexIdentity', 'indexBuildId',
        'serverIndexRequests', 'firstIndexBatchMs', 'indexCompleteMs', 'decoderBackend', 'colorMode', 'firstPtsUs', 'durationUs',
        'stableCoverageUs', 'seekAnchorCount', 'firstFrameReadyMs', 'nativeOpenCount', 'softwareOpenCount'];
      const traces = logs.events.filter(event => event.msg === '媒体管线追踪').map(event => Object.fromEntries(
        traceFields.filter(key => key in event.data).map(key => [key, event.data[key]])));
      assert.equal(traces.filter(event => event.phase === 'container-selected').length, 1,
        `${fixture.name}: browser/reference/browser switching must reuse the opened container session`);
      assert.equal(traces.filter(event => event.phase === 'first-frame-ready' && event.container !== 'ffmpeg').length, 1,
        `${fixture.name}: mode switching must not create a second media/index lifecycle`);
      assert.equal(indexRequests.length, indexRequestsBeforeSwitch, `${fixture.name}: mode switching must not request another frame index`);
      console.log(JSON.stringify({ phase: 'browser-reference-browser-switch', fixture: fixture.name, mediaId: entry.id, mediaVersion: entry.version, transitions, indexRequests, traces }));
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ summary: { engine, cases: results.length, fixtures: fixtures.map(item => item.name) } }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await library.close(); await rm(generated, { recursive: true, force: true });
}
