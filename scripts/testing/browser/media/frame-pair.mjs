// Internal bridge acceptance only: no application Session or GUI quality entry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { openAnalysisInput } from '../../../../shared/analysis/bitstream/input.ts';
import { preparedPair, pairRequest, wrapFlv } from '../../../../test/helpers/frame-pair-fixture.ts';
const engine = process.argv[2];
if (!['chromium', 'webkit'].includes(engine)) throw Error('Expected chromium or webkit');
const dir = await mkdtemp(join(tmpdir(), 'vp-pair-browser-'));
let browser, server;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, plugins: [{ name: 'quality-harness', configureServer(vite) {
    vite.middlewares.use((req, res, next) => { if (req.url !== '/__quality_bridge__') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Internal frame pair acceptance</title>'); });
  } }] });
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}/`;
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(base + '__quality_bridge__');
  for (const depth of [8, 10]) {
    const codec = depth === 8 ? 'h264' : 'hevc', file = join(dir, `${codec}.mp4`), format = depth === 8 ? 'yuv420p' : 'yuv420p10le';
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=1', '-frames:v', '2', '-filter_threads', '1', '-pix_fmt', format,
      '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-threads', '1', ...(codec === 'h264' ? ['-x264-params', 'keyint=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0']
        : ['-x265-params', 'keyint=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0:open-gop=0:pools=none:frame-threads=1:log-level=error']), file], { timeout: 30000, stdio: 'pipe' });
    const bytes = await readFile(file), input = await openAnalysisInput({ size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l), close() {} }, new AbortController().signal);
    const packets = await Promise.all(input.packets.map(p => input.readUnit(p)));
    const flv = wrapFlv(codec, input.configurations[0], packets, depth === 10); input.close();
    const a = await preparedPair(flv), b = await preparedPair(flv, 'd'.repeat(24), 1), request = pairRequest(a.target, b.target);
    const result = await page.evaluate(async ({ request, a, b, flv, base }) => {
      const { FramePairClient } = await import('/src/analysis/quality/pair-client.ts');
      const file = new Blob([new Uint8Array(flv)]), sources = [{ ...a, file }, { ...b, file }];
      const client = new FramePairClient();
      const result = await client.measure(request, sources, base, new AbortController().signal);
      const same = structuredClone(request); same.distorted = same.reference;
      const equal = await client.measure(same, [sources[0], sources[0]], base, new AbortController().signal);
      const invalid = structuredClone(request); invalid.roi.x = 1;
      let failure;
      try { await client.measure(invalid, sources, base, new AbortController().signal); }
      catch (error) { failure = { code: error.code, field: error.field }; }
      return { result, equal, failure };
    }, { request, a: { binding: a.source.binding, index: a.source.index }, b: { binding: b.source.binding, index: b.source.index }, flv: [...flv], base });
    assert.deepEqual(result.failure, { code: 'unsupported-format', field: 'roi.chroma-alignment' });
    assert.equal(result.result.metric.bitDepth, depth); assert.ok(result.result.metric.aggregate.sse > 0);
    assert.equal(result.equal.metric.aggregate.sse, 0); assert.equal(result.equal.metric.aggregate.psnr.kind, 'positive-infinity');
    assert.equal(result.result.provenance.distorted.picture.au, 1);
    assert.equal(result.result.provenance.reference.decoded.sourcePtsUs, request.reference.sourcePtsUs);
    assert.equal(result.result.provenance.distorted.decoded.sourcePtsUs, request.distorted.sourcePtsUs);
    assert.equal(result.result.decoder.backend, 'ffmpeg-wasm');
    // Exact independent native-plane answers are asserted in the registered Node media test.
    console.log(JSON.stringify({ engine, codec, depth, decoder: result.result.decoder, aggregate: result.result.metric.aggregate }));
  }
} finally { await browser?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
