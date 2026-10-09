import test from 'node:test';
import assert from 'node:assert/strict';
import { HDR_PREVIEW_POLICY, hdrTransfer, pqToNits, hlgToScene, hdrToDisplayNits, hdrToDisplayP3, hdrToSdrPreview, hdrYuvToRgba, resolveHdrPreviewPlan, validateHdrPreviewPolicy } from '../../src/hdr-color.ts';
import { resolveYuvColor } from '../../src/yuv-color.ts';
import { isHdrTransfer } from '../../src/presentation-color.ts';
import { yuvFixture } from '../helpers/yuv-fixture.ts';

const near = (actual: number, expected: number, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('BT.2100 PQ published luminance landmarks are absolute nits', () => {
  // Encoded PQ values independently tabulated for 100/203/1000 cd/m².
  for (const [signal, nits] of [[0, 0], [.508078421517399, 100], [.5806888810416109, 203], [.751827096247041, 1000], [1, 10000]]) near(pqToNits(signal), nits, 1e-6);
  near(pqToNits(-.1), 0); near(pqToNits(1.1), 10000, 1e-6);
});

test('HLG inverse OETF and luminance-coupled OOTF are separate', () => {
  near(hlgToScene(.5), 1 / 12); near(hlgToScene(1), 1);
  near(hdrToDisplayNits([.5, .5, .5], 'hlg')[0], 50.6970284911);
  near(hdrToDisplayNits([.75, .75, .75], 'hlg')[0], 203.1521453537, 1e-4);
  near(hdrToDisplayNits([1, 1, 1], 'hlg')[0], 1000, 1e-4); // published HLG a is rounded
  const colored = hdrToDisplayNits([1, .5, 0], 'hlg');
  near(colored[0] / colored[1], 12, 1e-5); // independent channel gamma would change this ratio
  near(colored[2], 0);
  assert.deepEqual(hdrToDisplayNits([0, 0, 0], 'hlg'), [0, 0, 0]);
});

test('preview ramps stay neutral, finite and monotonic; peak and policy are explicit', () => {
  for (const transfer of ['pq', 'hlg'] as const) {
    let previous = -1;
    for (let i = 0; i <= 1024; i++) {
      const [r, g, b] = hdrToSdrPreview([i / 1024, i / 1024, i / 1024], transfer);
      assert.ok(Number.isFinite(r) && r >= 0 && r <= 1 && r >= previous - 1e-10);
      near(r, g, 2e-6); near(g, b, 2e-6); previous = r;
    }
    assert.deepEqual(hdrToSdrPreview([0, 0, 0], transfer), [0, 0, 0]);
    const peak = hdrToSdrPreview(transfer === 'pq' ? [.751827096247041, .751827096247041, .751827096247041] : [1, 1, 1], transfer);
    for (const c of peak) near(c, 1, 2e-6);
  }
  const bright = hdrToSdrPreview([.6, .6, .6], 'pq');
  const darker = hdrToSdrPreview([.6, .6, .6], 'pq', { ...HDR_PREVIEW_POLICY, exposureWhiteNits: 400 });
  assert.ok(bright[0] > darker[0]);
});

test('saturated BT.2020 colors compress chroma without independent channel clipping', () => {
  const decode = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  for (const transfer of ['pq', 'hlg'] as const) for (const rgb of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.7, .2, .5]] as const) {
    const nits = hdrToDisplayNits(rgb, transfer);
    const luminance = nits[0] * .2627 + nits[1] * .678 + nits[2] * .0593;
    const x = luminance / 203, peak = 1000 / 203;
    const expected = Math.min(1, x * (1 + x / (peak * peak)) / (1 + x));
    const preview = hdrToSdrPreview(rgb, transfer);
    assert.ok(preview.every(c => Number.isFinite(c) && c >= 0 && c <= 1));
    const linear = preview.map(decode);
    near(linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722, expected, 6e-5);
  }
});

test('HDR admission requires actual tagged high-depth planes; shared presentation admits tagged raw HDR', () => {
  const f = yuvFixture(10, false, false, 'bt2020-ncl');
  f.description.color.transfer = 'pq';
  const before = structuredClone(f.description);
  assert.equal(resolveHdrPreviewPlan(f.description).supported, true);
  assert.equal(resolveYuvColor(f.description).supported, true);
  for (const transfer of ['pq', 'smpte2084', 'hlg', 'arib-std-b67']) { assert.ok(hdrTransfer(transfer)); assert.equal(isHdrTransfer(transfer), true); }
  assert.equal(hdrTransfer('bt709'), null);
  for (const color of [{ ...f.description.color, transfer: null }, { ...f.description.color, primaries: null }, { ...f.description.color, matrix: 'bt709' }, { ...f.description.color, fullRange: null }]) {
    assert.equal(resolveHdrPreviewPlan({ ...f.description, color }).supported, false);
  }
  assert.equal(resolveHdrPreviewPlan({ ...f.description, yuv: undefined, format: 'RGBA', sourceColor: f.description.color }).supported, false);
  assert.equal(resolveHdrPreviewPlan({ ...f.description, color: { ...f.description.color, transfer: 'bt709' }, sourceColor: f.description.color }).supported, false);
  assert.equal(resolveHdrPreviewPlan({ ...f.description, yuv: { ...f.description.yuv!, bitDepth: 8 } }).supported, false);
  assert.equal(resolveHdrPreviewPlan({ ...f.description, yuv: { ...f.description.yuv!, bitDepth: 13 } }).supported, false);
  assert.deepEqual(f.description, before);
});

test('high-depth HDR layouts keep shifts, range and padding; pixels and source tags are immutable', () => {
  for (const transfer of ['pq', 'hlg'] as const) for (const full of [false, true]) {
    const fixtures = [yuvFixture(10, false, full, 'bt2020-ncl'), yuvFixture(10, true, full, 'bt2020-ncl'), yuvFixture(10, true, full, 'bt2020-ncl', 5, 3, 6)];
    for (const f of fixtures) { f.description.color.transfer = transfer; f.description.sourceColor = { ...f.description.color }; }
    const expected = hdrYuvToRgba(fixtures[0].description, fixtures[0].pixels);
    for (const f of fixtures) {
      const before = structuredClone({ description: f.description, pixels: f.pixels });
      assert.deepEqual(hdrYuvToRgba(f.description, f.pixels), expected);
      assert.deepEqual(f.pixels, before.pixels); assert.deepEqual(f.description, before.description);
      f.description.visibleRect = { x: 1, y: 1, width: 3, height: 1 }; f.description.width = 3; f.description.height = 1;
      assert.equal(hdrYuvToRgba(f.description, f.pixels).length, 12);
    }
  }
});

test('preview conditions roundtrip as data and reject unknown or invalid policies', () => {
  validateHdrPreviewPolicy(JSON.parse(JSON.stringify(HDR_PREVIEW_POLICY)));
  for (const invalid of [{ sourcePeakNits: NaN }, { sourcePeakNits: 100 }, { exposureWhiteNits: 0 }, { exposureWhiteNits: Number.MIN_VALUE }, { hlgDisplayPeakNits: Infinity }, { hlgSystemGamma: .5 }, { presentation: 'unknown' }, { outputColorSpace: 'display-p3' }]) {
    assert.throws(() => validateHdrPreviewPolicy({ ...HDR_PREVIEW_POLICY, ...invalid } as typeof HDR_PREVIEW_POLICY));
  }
  const f = yuvFixture(10, false, false, 'bt2020-ncl'); f.description.color.transfer = 'pq';
  const a = resolveHdrPreviewPlan(f.description); a.policy.sourcePeakNits = 4000;
  assert.equal(resolveHdrPreviewPlan(f.description).policy.sourcePeakNits, 1000);
  for (const invalid of [NaN, Infinity, -Infinity]) { assert.throws(() => pqToNits(invalid)); assert.throws(() => hlgToScene(invalid)); }
});

test('10/12/16-bit PQ and HLG limited/full range endpoints retain black and white', () => {
  for (const depth of [10, 12, 16]) for (const full of [false, true]) for (const transfer of ['pq', 'hlg']) {
    const f = yuvFixture(depth, false, full, 'bt2020-ncl', 2, 1); f.description.color.transfer = transfer;
    assert.deepEqual([...hdrYuvToRgba(f.description, f.pixels)], [0, 0, 0, 255, 255, 255, 255, 255]);
  }
});


test('extended P3 output preserves PQ highlights and explicit reference white',()=>{
  for(const nits of [100,203,1000,10000]) {
    const signal=(()=>{const m1=2610/16384,m2=2523/32,p=(nits/10000)**m1;return ((3424/4096+2413/128*p)/(1+2392/128*p))**m2;})();
    const channels=hdrToDisplayP3([signal,signal,signal],'pq',203);
    const linear=(nits/203),encoded=linear<=.0031308?12.92*linear:1.055*linear**(1/2.4)-.055;
    channels.forEach(c=>near(c,encoded,1e-5));
    if(nits>203)assert.ok(channels.every(c=>c>1));
  }
  assert.deepEqual(hdrToDisplayP3([0,0,0],'pq'),[0,0,0]);
  const white=hdrToDisplayP3([1,1,1],'hlg');assert.ok(white.every(c=>c>1));
});
