import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFlvFramePair, FramePairError, PAIR_LIMITS } from '../../shared/analysis/quality/frame-pair.ts';
import type { PairDecoder, DecodedPairFrame, FramePairRequest } from '../../shared/analysis/quality/frame-pair.ts';
import type { PairWorker } from '../../src/analysis/quality/pair-client.ts';
import { FramePairClient } from '../../src/analysis/quality/pair-client.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import { preparedPair, pairRequest, wrapFlv, pairAvcc, admissionIdr } from '../helpers/frame-pair-fixture.ts';
const signal = () => new AbortController().signal;
function rawFrame(pts: number): DecodedPairFrame {
  return { pts, pixels: new Uint8Array(1536), description: rgbaDescription(32, 32, { format: 'YUV', stride: null, byteLength: 1536,
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    yuv: { bitDepth: 8, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1,
      planes: [{ offset: 0, stride: 32, width: 32, height: 32 }, { offset: 1024, stride: 16, width: 16, height: 16 }, { offset: 1280, stride: 16, width: 16, height: 16 }] } }) };
}
function decoder(onDecode?: () => void) {
  let closed = 0, decoded = 0;
  const value: PairDecoder = { version: { backend: 'ffmpeg-wasm', buildId: 'c'.repeat(40), frameAbi: 2, packetIdentity: 'isolated-closed-au-v1' },
    async decode(_codec, _configuration, _packet, pts) { decoded++; onDecode?.(); return rawFrame(pts); }, close() { closed++; } };
  return { value, get closed() { return closed; }, get decoded() { return decoded; } };
}
async function fixture() { return preparedPair(wrapFlv('h264', pairAvcc, [admissionIdr, admissionIdr])); }
const code = (expected: FramePairError['code']) => (error: unknown) => error instanceof FramePairError && error.code === expected;

test('explicit cross-source roles with unequal PTS preserve provenance; no playback cursor dependency', async () => {
  const a = await fixture(), b = await preparedPair(wrapFlv('h264', pairAvcc, [admissionIdr], true, 5000), 'd'.repeat(24));
  const r = pairRequest(a.target, b.target), d = decoder(); let closed = 0;
  const sources = [a.open(), b.open()] as const;
  for (const source of sources) source.close = () => { closed++; };
  const output = await measureFlvFramePair(r, [...sources], async () => d.value, signal());
  assert.equal(output.metric.aggregate.sse, 0); assert.equal(output.metric.aggregate.samples, 720);
  assert.equal(output.provenance.reference.sourcePtsUs, 2000000); assert.equal(output.provenance.distorted.sourcePtsUs, 5000000);
  assert.equal(output.pairing, 'caller-specified'); assert.equal(output.correspondence, 'caller-specified-no-content-or-time-alignment');
  assert.equal(d.closed, 1); assert.equal(closed, 2); assert.equal(d.decoded, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
  r.reference.picture.au = 99; assert.equal(output.provenance.reference.picture.au, 0);
});

for (const fault of ['au', 'pts', 'namespace', 'build', 'version', 'duplicate-pts', 'missing-cache', 'tag', 'prefix', 'dependent', 'multi-config'] as const)
  test(`cached pair fails closed: ${fault}`, async () => {
    const a = await fixture(), r = pairRequest(a.target), source = a.open(); let expected: FramePairError['code'] = 'identity-mismatch';
    if (fault === 'au') r.reference.picture.au = 99;
    if (fault === 'pts') r.reference.sourcePtsUs++;
    if (fault === 'namespace') { r.reference.indexIdentity.indexerBuild = 'old'; expected = 'invalid-request'; }
    if (fault === 'build') { r.reference.indexBuildId = 'different'; expected = 'source-changed'; }
    if (fault === 'version') { r.reference.mediaVersion = 'e'.repeat(24); r.reference.picture.sourceVersion = `${r.reference.mediaId}@${r.reference.mediaVersion}`; expected = 'source-changed'; }
    if (fault === 'duplicate-pts') source.index!.packets[1][2] = source.index!.packets[0][2];
    if (fault === 'missing-cache') { source.index = null; expected = 'cache-miss'; }
    if (fault === 'tag') { r.reference.picture.au = 1; r.reference.sourcePtsUs = 3000000; source.index!.packets[1][3]++; }
    if (fault === 'prefix') source.index!.description[4] = 0xfe;
    if (fault === 'dependent') { const read = source.read; source.read = async (o, l) => { const bytes = await read(o, l); if (o === source.index!.packets[0][0] && l === admissionIdr.length) bytes[4] = 0x41; return bytes; }; expected = 'unsupported-source'; }
    if (fault === 'multi-config') { source.index!.configurations = [source.index!.description, source.index!.description]; expected = 'unsupported-source'; }
    let closed = 0; source.close = () => { closed++; };
    await assert.rejects(measureFlvFramePair(r, [source, a.open()], async () => assert.fail('no decoder before identity admission'), signal()), code(expected));
    assert.equal(closed, 1);
  });

test('source version drift during IO or decode fails and closes owned resources', async () => {
  for (const phase of ['read', 'decode']) {
    const a = await fixture(), s = a.open(), r = pairRequest(a.target), original = s.binding; let changed = false;
    s.binding = () => ({ ...original(), mediaVersion: changed ? 'e'.repeat(24) : original().mediaVersion });
    const read = s.read; s.read = async (...args) => { const bytes = await read(...args); if (phase === 'read') changed = true; return bytes; };
    const d = decoder(() => { if (phase === 'decode') changed = true; });
    await assert.rejects(measureFlvFramePair(r, [s, a.open()], async () => d.value, signal()), code('source-changed'));
    assert.equal(d.closed, phase === 'decode' ? 1 : 0);
  }
});

for (const budget of [{ maxReadBytes: 1 }, { maxPacketBytes: 1 }, { maxIndexPackets: 1 }, { maxIndexBytes: 1 }, { maxPixels: 1 }, { maxFrameBytes: 1 }, { maxPackets: 1 }, { maxOutputFrames: 1 }, { maxSamples: 1 }, { maxInputBytes: 1 }])
  test(`pair budget ${JSON.stringify(budget)} fails without a score`, async () => {
    const a = await fixture(), r: FramePairRequest = { ...pairRequest(a.target), budget }, d = decoder();
    await assert.rejects(measureFlvFramePair(r, [a.open(), a.open()], async () => d.value, signal()), error => error instanceof Error && 'code' in error && error.code === 'budget-exceeded');
  });

test('ROI incompatibility, output identity, missing chroma location, invalid caps and cancellation retain failure', async () => {
  const a = await fixture();
  for (const fault of ['roi', 'pts', 'chroma', 'caps', 'abort']) {
    const r = pairRequest(a.target), d = decoder(), controller = new AbortController();
    if (fault === 'roi') r.roi.x = 1;
    if (fault === 'pts' || fault === 'chroma') d.value.decode = async () => { const f = rawFrame(2000000); if (fault === 'pts') f.pts++; else f.description.yuv!.chromaLocation = 0; return f; };
    if (fault === 'caps') r.budget = { maxReadBytes: PAIR_LIMITS.maxReadBytes + 1 };
    if (fault === 'abort') controller.abort();
    await assert.rejects(measureFlvFramePair(r, [a.open(), a.open()], async () => d.value, controller.signal));
    assert.equal(d.closed, ['caps', 'abort'].includes(fault) ? 0 : 1);
  }
});

class FakeWorker {
  onmessage: PairWorker['onmessage'] = null; onerror: PairWorker['onerror'] = null; onmessageerror: PairWorker['onmessageerror'] = null;
  terminated = 0; sent = 0; throwPost = false; throwTerminate = false; onTerminate?: () => void;
  postMessage() { this.sent++; if (this.throwPost) throw Error('post failed'); }
  terminate() { this.terminated++; this.onTerminate?.(); if (this.throwTerminate) throw Error('terminate failed'); }
}
for (const terminal of ['success', 'failure', 'abort', 'timeout', 'error', 'messageerror', 'post', 'construct', 'terminate'] as const)
  test(`Worker terminal ${terminal}: terminate before releasing admission; ignore late events`, async () => {
    const a = await fixture(), r = pairRequest(a.target), controller = new AbortController(), workers: FakeWorker[] = [];
    let constructionFails = terminal === 'construct';
    const client = new FramePairClient(() => { if (constructionFails) { constructionFails = false; throw Error('construct failed'); } const w = new FakeWorker(); workers.push(w); return w; });
    if (terminal === 'timeout') r.budget = { maxElapsedMs: 1 };
    // Factory setup must precede synchronous initial post.
    const originalFactoryClient = terminal === 'post' ? new FramePairClient(() => { const w = new FakeWorker(); w.throwPost = true; workers.push(w); return w; }) : client;
    const promise = originalFactoryClient.measure(r, [a.source, a.source], 'http://localhost/', controller.signal);
    const w = workers[0], late = w?.onmessage;
    let duringTermination: Promise<void> | undefined;
    if (w) w.onTerminate = () => { duringTermination = assert.rejects(originalFactoryClient.measure(r, [a.source, a.source], '', signal()), code('busy')); };
    if (!['post', 'construct'].includes(terminal)) await assert.rejects(client.measure(r, [a.source, a.source], '', signal()), code('busy'));
    if (terminal === 'success') w.onmessage?.({ data: { ok: true, result: { sentinel: true } } } as MessageEvent);
    if (terminal === 'failure') w.onmessage?.({ data: { ok: false, code: 'cache-miss', error: 'missing' } } as MessageEvent);
    if (terminal === 'abort') controller.abort();
    if (terminal === 'error') w.onerror?.({ message: 'worker failed' } as ErrorEvent);
    if (terminal === 'messageerror') w.onmessageerror?.({} as MessageEvent);
    if (terminal === 'terminate') { w.throwTerminate = true; controller.abort(); }
    if (terminal === 'success') await promise; else await assert.rejects(promise);
    await duringTermination;
    if (w) { assert.equal(w.terminated, 1); assert.equal(w.onmessage, null); assert.equal(w.onerror, null); assert.equal(w.onmessageerror, null); }
    late?.({ data: { ok: true, result: {} } } as MessageEvent);
    if (terminal === 'terminate') await assert.rejects(client.measure(r, [a.source, a.source], '', signal()), code('busy'));
    else if (terminal !== 'post') {
      const nextAbort = new AbortController(), next = client.measure(pairRequest(a.target), [a.source, a.source], '', nextAbort.signal);
      const newest = workers.at(-1)!;
      nextAbort.abort(); await assert.rejects(next); assert.equal(newest.terminated, 1);
    }
  });

test('asynchronous Worker exit retains admission until termination acknowledgement', async () => {
  const a = await fixture(), r = pairRequest(a.target); let acknowledge!: () => void;
  const stopped = new Promise<void>(resolve => { acknowledge = resolve; });
  const worker: PairWorker = { onmessage: null, onerror: null, onmessageerror: null, postMessage() {}, terminate() { return stopped; } };
  const client = new FramePairClient(() => worker), abort = new AbortController();
  const run = client.measure(r, [a.source, a.source], '', abort.signal), rejected = assert.rejects(run, { name: 'AbortError' });
  abort.abort();
  await assert.rejects(client.measure(r, [a.source, a.source], '', signal()), code('busy'));
  acknowledge(); await rejected;
  const nextAbort = new AbortController(), next = client.measure(r, [a.source, a.source], '', nextAbort.signal);
  nextAbort.abort(); await assert.rejects(next);
});

test('WASM memory growth cap rejects initial and subsequent over-budget allocations', async () => {
  const { limitMemoryGrowth, WasmMemoryBudgetError } = await import('../../shared/wasm/core.ts');
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
  assert.throws(() => limitMemoryGrowth(memory, 65535), WasmMemoryBudgetError);
  limitMemoryGrowth(memory, 2 * 65536);
  assert.equal(memory.grow(1), 1); assert.equal(memory.buffer.byteLength, 2 * 65536);
  assert.throws(() => memory.grow(1), WasmMemoryBudgetError);
  assert.equal(memory.buffer.byteLength, 2 * 65536);
});
