// Production-bundle FLV regression, no screenshots or persistent services.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
// The native-decode policy (prefer WebCodecs when the platform accepts the
// config) can only be observed where the platform accepts it. When the
// browser's own probe refuses the AVC config, the WASM fallback is correct:
// document the refusal instead of failing (e.g. Linux CI WebKit without an
// AVC VideoDecoder). A runtime native failure, or support without selection,
// stays a hard failure.
function nativeRefusal(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) return null;
  if (decisions.some(d => d?.reason === 'native-failed')) return null;
  const refused = decisions.every(d =>
    d?.reason === 'webcodecs-unavailable' || d?.reason === 'no-native-config' ||
    d?.reason === 'avc-reorder-policy' ||
    (d?.reason === 'capability-probe' && d.supported === false));
  return refused ? decisions : null;
}
const root = path.resolve(import.meta.dirname, '..');
const browserName = process.argv[2] ?? 'webkit';
const server = createMediaServer({ roots: [path.join(root, 'fixtures/flv')], staticDir: path.join(root, 'dist'), onLog() {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await (browserName === 'chromium' ? chromium : webkit).launch({ headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['standard-h264', 'legacy-hevc', 'private-av1', 'private-vvc', 'enhanced-hevc', 'enhanced-av1', 'enhanced-vvc']) {
    if (process.env.FLV_CASE && name !== process.env.FLV_CASE) continue;
    const page = await browser.newPage();
    const errors = [], mediaRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/api\/media\/[0-9a-f]+$/.test(new URL(request.url()).pathname)) mediaRequests.push(request.headers()); });
    try {
      await page.goto(base);
      await page.waitForFunction(() => !!window.voidPlayer);
      const reference = JSON.parse(await readFile(path.join(root, 'fixtures/flv', name + '.json'), 'utf8'));
      const result = await page.evaluate(async ({ name, reference }) => {
        const call = async (name, params = {}) => { try { return await window.voidPlayer.tools.find(t => t.name === name).execute(params); } catch (e) { throw new Error(name + ' ' + JSON.stringify(params) + ': ' + e.message); } };
        const listing = await call('list_library');
        const item = listing.entries.find(e => e.name === name + '.flv');
        if (!item) throw new Error('Missing FLV library fixture: ' + name);
        // Select reference mode explicitly: fresh profiles default to browser colors.
        await call('set_review_color_mode', { mode: 'reference' });
        await call('set_reference_decode', { decoder: 'software', depth: 2 });
        await call('load_library_item', { id: item.id, slot: 'A' });
        const referenceDecoder = (await call('get_review_session')).tracks[0].decoder;
        await call('set_review_color_mode', { mode: 'browser' });
        const states = [];
        for (const ptsUs of [0, 500000, 0, reference.times.at(-1) - reference.times[0]]) {
          await call('seek_review', { ptsUs }); states.push(await call('get_review_session'));
        }
        await call('seek_review', { ptsUs: 0 });
        await call('step_review', { direction: 1 });
        states.push(await call('get_review_session'));
        // Leave a margin above the 1000 ms minimum: the last rendered frame
        // can precede the polling deadline by one refresh interval.
        const benchmark = await call('benchmark_review', { durationMs: 1200 });
        const probeLogs = await call('get_review_logs', { level: 'info', limit: 500 });
        const probeDecisions = probeLogs.events
          .filter(e => e.cat === 'media' && e.msg === '原生解码路径探测')
          .flatMap(e => e.data?.decisions ?? []);
        return { states, benchmark, referenceDecoder, probeDecisions };
      }, { name, reference });
      assert.deepEqual(errors, []);
      assert.ok(mediaRequests.length > 0);
      assert.ok(mediaRequests.every(r => /^bytes=/.test(r.range ?? '')), 'FLV must never download the whole library file');
      assert.equal(result.referenceDecoder, 'ffmpeg-wasm', 'reference mode forces WASM for FLV');
      const first = result.states[0].tracks[0];
      assert.equal(first.codec, reference.codec);
      let nativeSkipped = false;
      if (name === 'standard-h264' && first.decoder !== 'webcodecs') {
        const refusal = nativeRefusal(result.probeDecisions);
        assert.ok(refusal, `FLV native policy violation: chose ${first.decoder} without a platform refusal: ${JSON.stringify(result.probeDecisions).slice(0, 2000)}`);
        nativeSkipped = true;
      } else {
        if (name === 'standard-h264') assert.equal(first.decoder, 'webcodecs');
      }
      if (name.includes('vvc')) assert.equal(first.decoder, 'ffmpeg-wasm');
      assert.equal(first.frame.sourcePtsUs, reference.times[0]);
      assert.equal(result.states[2].tracks[0].frame.sourcePtsUs, reference.times[0]);
      assert.equal(result.states[3].tracks[0].frame.sourcePtsUs, reference.times.at(-1));
      assert.equal(result.states[4].tracks[0].frame.sourcePtsUs, reference.times[1]);
      assert.equal(result.benchmark.passed, true, JSON.stringify({error: result.benchmark.error, failures: result.benchmark.failures, measurements: result.benchmark.measurements}));
      if (name === 'standard-h264') {
        await page.locator('#file-A').setInputFiles({ name: 'renamed.bin', mimeType: 'application/octet-stream', buffer: await readFile(path.join(root, 'fixtures/flv', name + '.flv')) });
        await page.waitForFunction(() => { const t = window.voidPlayer.tools.find(t => t.name === 'get_review_session'); return Promise.resolve(t.execute({})).then(s => !s.busy && s.tracks[0]?.name === 'renamed.bin' && s.tracks[0]?.frame?.ptsUs === 0); });
      }
      console.log(`${nativeSkipped ? 'SKIP' : 'PASS'} ${browserName} ${name}: ${first.decoder}${nativeSkipped ? ' (native AVC unsupported here, wasm fallback verified)' : ''}, ${mediaRequests.length} Range reads`);
    } finally { await page.close(); }
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
