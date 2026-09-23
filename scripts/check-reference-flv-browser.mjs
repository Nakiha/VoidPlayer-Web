// Real native/WASM decoding through the production facade. Synthetic SDR
// clips isolate policy; hardware/GPU use and high-resolution speed are separate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';

const root = await mkdtemp(path.join(tmpdir(), 'vp-reference-flv-'));
const unhex = dump => Buffer.from(dump.split('\n').filter(l => l.includes(': ')).map(l => l.split(': ')[1].split('  ')[0].replaceAll(' ', '')).join(''), 'hex');
const u24 = n => { const b = Buffer.alloc(3); b.writeUIntBE(n & 0xffffff, 0, 3); return b; };
const tag = (data, time) => { const size = Buffer.alloc(4); size.writeUInt32BE(11 + data.length); return Buffer.concat([Buffer.from([9]), u24(data.length), u24(time), Buffer.from([time >>> 24, 0, 0, 0]), data, size]); };
async function fixture(codec) {
  const file = path.join(root, `${codec}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=25', '-t', '3', '-an',
    '-c:v', codec === 'h264' ? 'libx264' : codec === 'hevc' ? 'libx265' : 'libaom-av1', '-threads', '1',
    ...(codec === 'av1' ? ['-cpu-used', '8'] : ['-preset', 'ultrafast']), '-g', '25', '-bf', '0',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...(codec === 'hevc' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error', '-tag:v', 'hvc1'] : []), file], { timeout: 30000 });
  const doc = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_packets', '-show_data', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const id = codec === 'h264' ? 7 : codec === 'hevc' ? 12 : 13;
  const parts = [Buffer.from('464c5601010000000900000000', 'hex'), tag(Buffer.concat([Buffer.from([0x10 | id, 0, 0, 0, 0]), unhex(doc.streams[0].extradata)]), 0)];
  for (const packet of doc.packets) {
    const pts = Math.round(Number(packet.pts_time) * 1000) + 2000, dts = Math.round(Number(packet.dts_time) * 1000) + 2000;
    parts.push(tag(Buffer.concat([Buffer.from([(packet.flags.includes('K') ? 0x10 : 0x20) | id, 1]), u24(pts - dts), unhex(packet.data)]), dts));
  }
  await writeFile(path.join(root, `${codec}.flv`), Buffer.concat(parts));
}
let library, server, browser;
try {
  await fixture('h264'); await fixture('hevc'); await fixture('av1');
  library = new MediaLibraryIndex([root], { watch: false }); await library.refresh();
  server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.argv[2] ?? 'chromium';
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
    ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  async function run({ codec = 'h264', local = false, fault, software = false } = {}) {
    const context = await browser.newContext(), page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(software => {
      localStorage.setItem('voidplayer.color-mode', 'reference');
      if (software) localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ decoder: 'software', depth: 2 }));
    }, software);
    if (fault) await page.route(/\/assets\/(packet-worker|native-yuv-worker)-.*\.js$/, async route => {
      const response = await route.fetch(); let prefix = '';
      if (fault === 'unsupported' && route.request().url().includes('/packet-worker-')) prefix = 'VideoDecoder.isConfigSupported=async config=>({supported:false,config});';
      if (route.request().url().includes('/native-yuv-worker-')) {
        if (fault === 'readback') prefix = 'VideoFrame.prototype.copyTo=async()=>{throw new DOMException("injected readback refusal","NotSupportedError")};';
        if (fault === 'mismatch') prefix = 'const originalCopy=VideoFrame.prototype.copyTo;VideoFrame.prototype.copyTo=async function(bytes,options){const layout=await originalCopy.call(this,bytes,options);bytes[0]^=1;return layout;};';
      }
      await route.fulfill({ response, body: prefix + await response.text() });
    });
    try {
      await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
      const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
      assert.deepEqual((await call('get_review_session')).referenceDecode, { decoder: software ? 'software' : 'hardware', depth: 2 });
      if (local) {
        await page.locator('#file-A').setInputFiles({ name: 'renamed.bin', mimeType: 'application/octet-stream', buffer: await readFile(path.join(root, `${codec}.flv`)) });
        await page.waitForFunction(() => { const s = window.voidPlayer.getState(); return !s.busy && s.tracks[0]?.frame; });
      } else {
        const listing = await call('list_library');
        await call('load_library_item', { id: listing.entries.find(e => e.name === `${codec}.flv`).id, slot: 'A' });
      }
      const state = await call('get_review_session'), logs = await call('get_review_logs', { limit: 500 });
      const decisions = logs.events.filter(e => e.msg === '原生解码路径探测').flatMap(e => e.data?.decisions ?? []);
      if (fault || software) assert.equal(state.tracks[0].decoder, 'ffmpeg-wasm');
      else if (state.tracks[0].decoder !== 'webcodecs') {
        const refusal = decisions.length && decisions.every(d => d.reason === 'webcodecs-unavailable' || d.reason === 'capability-probe' && !d.supported);
        const gate = logs.events.find(e => e.msg === 'WebCodecs 路径不可用，尝试 WASM 回退');
        assert.ok(refusal || gate, JSON.stringify({ decisions, events: logs.events.filter(e => e.cat === 'media') }));
        if (codec === 'av1' && !refusal) {
          // Playwright WebKit on Linux reports AV1 probe support but ships no AV1
          // decoder: first-frame failure with a working WASM fallback is the platform
          // gap, not an admission bug (see verification notes). Chromium keeps the rule.
          const webkitAv1DecodeGap = engine === 'webkit' && !fault && !software
            && decisions.some(d => d.reason === 'native-failed');
          if (!webkitAv1DecodeGap) assert.fail(`AV1 raw-plane admission unexpectedly failed: ${JSON.stringify(gate)}`);
          else console.log('PLATFORM GAP webkit av1: probe passed but first-frame decode failed, WASM fallback active');
        }
        console.log(`ADMISSION REFUSAL ${codec}: ${JSON.stringify(gate?.data ?? decisions)}`);
      } else assert.ok(state.tracks[0].output.yuv, 'native source reaches raw YUV output');
      if (software) assert.equal(decisions.length, 0, 'explicit software skips native probing');
      else assert.ok(decisions.length > 0, 'reference hardware actually probes native FLV');
      if (fault === 'readback' || fault === 'mismatch') assert.ok(logs.events.some(e => e.msg === 'WebCodecs 路径不可用，尝试 WASM 回退' && (fault === 'mismatch' ? /平面 .*样本不一致/.test(e.data?.reason) : /injected readback/.test(e.data?.reason))), 'fallback reports the actual admission failure');
      for (const ptsUs of [1000000, 0, 500000]) await call('seek_review', { ptsUs });
      assert.equal((await call('get_review_session')).tracks[0].frame.ptsUs, 480000);
      if (!fault && !software && codec === 'av1' && !local) {
        const benchmark = await call('benchmark_review', { durationMs: 1200 });
        console.log(`BENCH ${JSON.stringify(benchmark)}`);
        assert.equal(benchmark.error, null); assert.equal(benchmark.staleAfterPause, false);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: ${codec} ${local ? 'local sniff' : 'remote'} ${fault ?? (software ? 'saved software' : 'default hardware')} -> ${state.tracks[0].decoder}`);
    } finally { await context.close(); }
  }
  await run(); await run({ local: true }); await run({ codec: 'hevc' }); await run({ codec: 'hevc', local: true }); await run({ codec: 'av1' }); await run({ codec: 'av1', local: true });
  await run({ software: true });
  // Faults exercise readback and full-plane certification, not just selection.
  if (engine === 'chromium') { await run({ codec: 'av1', fault: 'unsupported' }); await run({ codec: 'av1', fault: 'readback' }); await run({ codec: 'av1', fault: 'mismatch' }); }
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await library?.close(); await rm(root, { recursive: true, force: true });
}
