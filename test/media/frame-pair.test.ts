import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openAnalysisInput } from '../../shared/analysis/bitstream/input.ts';
import { FramePairClient } from '../../src/analysis/quality/pair-client.ts';
import type { PairWorker } from '../../src/analysis/quality/pair-client.ts';
import { measurePsnr } from '../../shared/analysis/quality/psnr.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import { FlvEngine } from '../../src/media/decoding/flv-engine.ts';
import { preparedPair, pairRequest, wrapFlv } from '../helpers/frame-pair-fixture.ts';
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], { timeout: 30000, stdio: 'pipe' });
function workerClient(stall = false) {
  let exited = false, terminated = false, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const client = new FramePairClient(() => {
    exited = false;
    const worker = new Worker(new URL('../helpers/frame-pair-worker.ts', import.meta.url), { workerData: { stall } });
    const adapter: PairWorker = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage(data: unknown) { worker.postMessage(data); },
      async terminate() { terminated = true; await worker.terminate(); assert.equal(exited, true, 'capacity cannot precede actual Node Worker exit'); } };
    worker.on('message', data => { if (data.started) start(); else adapter.onmessage?.({ data } as MessageEvent); });
    worker.on('error', error => adapter.onerror?.({ message: String(error) } as ErrorEvent));
    worker.on('messageerror', () => adapter.onmessageerror?.({} as MessageEvent));
    worker.on('exit', () => { exited = true; });
    return adapter;
  });
  return { client, started, get exited() { return exited; }, get terminated() { return terminated; } };
}
const base = pathToFileURL(resolve('public/index.html')).href;
function nativeFrame(pixels: Uint8Array, depth: 8 | 10) {
  const bytes = depth === 8 ? 1 : 2;
  return { pixels, description: rgbaDescription(32, 32, { format: 'YUV', stride: null, byteLength: pixels.length,
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    yuv: { bitDepth: depth, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1,
      planes: [{ offset: 0, stride: 32 * bytes, width: 32, height: 32 }, { offset: 1024 * bytes, stride: 16 * bytes, width: 16, height: 16 }, { offset: 1280 * bytes, stride: 16 * bytes, width: 16, height: 16 }] } }) };
}
for (const [codec, depth] of [['h264', 8], ['hevc', 8], ['hevc', 10]] as const)
  test(`real isolated Worker ${codec} ${depth}-bit legacy/enhanced: native-plane exact SSE and independent playback`, { timeout: 90000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'vp-pair-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const format = depth === 8 ? 'yuv420p' : 'yuv420p10le', file = join(dir, 'source.mp4');
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=1', '-frames:v', '2', '-filter_threads', '1', '-pix_fmt', format,
      '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-threads', '1', ...(codec === 'h264' ? ['-x264-params', 'keyint=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0'] : ['-x265-params', 'keyint=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0:open-gop=0:repeat-headers=0:pools=none:frame-threads=1:log-level=error']),
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-chroma_sample_location', 'left', file]);
    const mp4 = await readFile(file), input = await openAnalysisInput({ size: mp4.length, read: async (o, l) => mp4.subarray(o, o + l), close() {} }, new AbortController().signal);
    const packets = await Promise.all(input.packets.map(p => input.readUnit(p))), configuration = input.configurations[0]; input.close();
    const native = ffmpeg(['-v', 'error', '-i', file, '-frames:v', '2', '-pix_fmt', format, '-f', 'rawvideo', '-']);
    const frameBytes = 1536 * (depth === 8 ? 1 : 2); assert.equal(native.length, frameBytes * 2);
    for (const enhanced of [false, true]) {
      const bytes = wrapFlv(codec, configuration, packets, enhanced), a = await preparedPair(bytes), b = await preparedPair(bytes, 'd'.repeat(24), 1);
      const playback = new FlvEngine({ file: a.source.file });
      try {
        await playback.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
          new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), true);
        await playback.completeIndex();
        const shown = await playback.at(a.target.sourcePtsUs), shownBytes = new Uint8Array(shown.pixels!).slice();
        let playbackCalls = 0;
        for (const name of ['reset', 'send', 'receive', 'drain'] as const) {
          const original = playback.decoder[name].bind(playback.decoder);
          (playback.decoder as any)[name] = (...args: any[]) => { playbackCalls++; return (original as any)(...args); };
        }
        const r = pairRequest(a.target, b.target), owner = workerClient();
        const actual = await owner.client.measure(r, [a.source, b.source], base, new AbortController().signal);
        assert.equal(owner.terminated, true); assert.equal(owner.exited, true);
        const expected = measurePsnr({ domain: 'source-yuv-code-values', reference: nativeFrame(Uint8Array.from(native.subarray(0, frameBytes)), depth),
          distorted: nativeFrame(Uint8Array.from(native.subarray(frameBytes)), depth), roi: r.roi });
        assert.deepEqual(actual.metric, expected); assert.ok(expected.aggregate.sse > 0);
        assert.equal(actual.metric.bitDepth, depth); assert.equal(actual.decoder.backend, 'ffmpeg-wasm');
        assert.match(actual.decoder.buildId, /^[a-f0-9]{40}$/); assert.equal(actual.work.outputFrames, 2);
        assert.equal(actual.provenance.reference.picture.au, 0); assert.equal(actual.provenance.distorted.picture.au, 1);
        assert.equal(playbackCalls, 0, 'independent scoring performs no playback decoder operations');
        assert.deepEqual(new Uint8Array(shown.pixels!), shownBytes, 'retained playback pixels unchanged');
        const next = await playback.next(shown.pts); assert.equal(next?.pts, b.target.sourcePtsUs); next?.frame?.close(); shown.frame?.close();
        t.diagnostic(JSON.stringify({ codec, depth, enhanced, decoder: actual.decoder, sse: actual.metric.aggregate.sse, work: actual.work }));
      } finally { playback.close(); }
    }
  });

test('actual stalled Worker cancellation/timeout waits for exit before readmission', { timeout: 20000 }, async () => {
  const { pairAvcc, admissionIdr } = await import('../helpers/frame-pair-fixture.ts');
  const a = await preparedPair(wrapFlv('h264', pairAvcc, [admissionIdr]));
  for (const cause of ['abort', 'timeout']) {
    const owner = workerClient(true), controller = new AbortController(), r = pairRequest(a.target);
    if (cause === 'timeout') r.budget = { maxElapsedMs: 500 };
    const running = owner.client.measure(r, [a.source, a.source], base, controller.signal);
    const rejected = assert.rejects(running, cause === 'timeout' ? /deadline/ : { name: 'AbortError' });
    await owner.started;
    if (cause === 'abort') controller.abort();
    await assert.rejects(owner.client.measure(r, [a.source, a.source], base, new AbortController().signal), /already running/);
    await rejected;
    assert.equal(owner.exited, true); assert.equal(owner.terminated, true);
    const againController = new AbortController(), again = owner.client.measure(r, [a.source, a.source], base, againController.signal);
    againController.abort(); await assert.rejects(again);
  }
});

test('real WASM instantiation honors a smaller heap admission budget', { timeout: 10000 }, async () => {
  const { openPairDecoder } = await import('../../src/analysis/quality/wasm-decoder.ts');
  await assert.rejects(openPairDecoder(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,
    new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')), 1), error =>
      error instanceof Error && 'code' in error && error.code === 'budget-exceeded');
});
