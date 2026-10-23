import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePsnr, PsnrError, PSNR_LIMITS } from '../../shared/analysis/quality/psnr.ts';
import type { PsnrFrame, PsnrRequest, PsnrRoi, PsnrValue } from '../../shared/analysis/quality/psnr.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';

function frame(depth: 8 | 10 = 8, options: { width?: number; height?: number; codedWidth?: number; codedHeight?: number;
  cropX?: number; cropY?: number; padding?: number; byteOffset?: number; value?: (c: number, x: number, y: number) => number } = {}): PsnrFrame {
  const width = options.width ?? 4, height = options.height ?? 4, cw = options.codedWidth ?? width, ch = options.codedHeight ?? height;
  const bytes = depth === 8 ? 1 : 2;
  let length = 0;
  const planes = Array.from({ length: 3 }, (_, c) => {
    const w = cw / (c ? 2 : 1), h = ch / (c ? 2 : 1), stride = w * bytes + (options.padding ?? 0);
    const plane = { offset: length, stride, width: w, height: h }; length += stride * h; return plane;
  });
  const storage = new ArrayBuffer(length + (options.byteOffset ?? 0)), pixels = new Uint8Array(storage, options.byteOffset ?? 0, length);
  pixels.fill(0xda);
  for (let c = 0; c < 3; c++) for (let y = 0; y < planes[c].height; y++) for (let x = 0; x < planes[c].width; x++) {
    const value = options.value?.(c, x, y) ?? 16, i = planes[c].offset + y * planes[c].stride + x * bytes;
    pixels[i] = value & 255; if (bytes === 2) pixels[i + 1] = value >> 8;
  }
  return { pixels, description: rgbaDescription(width, height, { codedWidth: cw, codedHeight: ch,
    visibleRect: { x: options.cropX ?? 0, y: options.cropY ?? 0, width, height }, format: 'YUV', stride: null, byteLength: length,
    color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    yuv: { bitDepth: depth, bitShift: 0, subsampleX: 1, subsampleY: 1, semiplanar: false, chromaLocation: 1, planes } }) };
}
function request(reference = frame(), distorted = frame(), roi: PsnrRoi = { x: 0, y: 0, width: 4, height: 4 }): PsnrRequest {
  return { domain: 'source-yuv-code-values', reference, distorted, roi };
}
function db(value: PsnrValue) { assert.equal(value.kind, 'finite'); return value.db!; }
function fails(r: PsnrRequest, code: PsnrError['code'], field?: string) {
  assert.throws(() => measurePsnr(r), (error: unknown) => error instanceof PsnrError && error.code === code && (!field || error.field === field));
}

test('8/10-bit equal source planes have lossless JSON-safe PSNR and explicit provenance limits', () => {
  for (const depth of [8, 10] as const) {
    const result = measurePsnr(request(frame(depth), frame(depth)));
    assert.deepEqual(result.aggregate, { sse: 0, samples: 24, mse: 0, psnr: { kind: 'positive-infinity', db: null } });
    for (const plane of Object.values(result.planes)) assert.deepEqual(plane.psnr, { kind: 'positive-infinity', db: null });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(result.peak, depth === 8 ? 255 : 1023);
    assert.equal(result.domain, 'source-yuv-code-values'); assert.equal(result.pairing, 'caller-supplied-unverified');
    assert.equal(result.work.bytesRead, depth === 8 ? 48 : 96);
  }
});

test('known unit errors preserve all 10-bit precision and the fixed code-value peak', () => {
  for (const depth of [8, 10] as const) {
    const reference = frame(depth, { value: () => depth === 8 ? 128 : 512 });
    const distorted = frame(depth, { value: () => depth === 8 ? 129 : 513 });
    const result = measurePsnr(request(reference, distorted));
    assert.equal(result.aggregate.sse, 24); assert.equal(result.aggregate.mse, 1);
    assert.ok(Math.abs(db(result.aggregate.psnr) - 20 * Math.log10(depth === 8 ? 255 : 1023)) < 1e-12);
    assert.equal(result.color.fullRange, false); // limited range still uses 255/1023, not 219/876.
    reference.description.color.fullRange = distorted.description.color.fullRange = true;
    assert.deepEqual(measurePsnr(request(reference, distorted)).aggregate, result.aggregate);
  }
});

test('aggregate uses SSE/sample counts with 4:1:1 component weighting, never average dB', () => {
  const result = measurePsnr(request(frame(), frame(8, { value: c => 16 + [2, 4, 8][c] })));
  assert.deepEqual(Object.values(result.planes).map(p => [p.sse, p.samples, p.mse]), [[64, 16, 4], [64, 4, 16], [256, 4, 64]]);
  assert.equal(result.aggregate.sse, 384); assert.equal(result.aggregate.samples, 24); assert.equal(result.aggregate.mse, 16);
  assert.ok(Math.abs(db(result.aggregate.psnr) - 10 * Math.log10(255 ** 2 / 16)) < 1e-12);
  assert.notEqual(db(result.aggregate.psnr), Object.values(result.planes).reduce((n, p) => n + db(p.psnr), 0) / 3);
  const onePlane = measurePsnr(request(frame(), frame(8, { value: c => 16 + (c === 0 ? 1 : 0) })));
  assert.equal(onePlane.planes.u.psnr.kind, 'positive-infinity'); assert.equal(onePlane.aggregate.sse, 16);
  assert.equal(onePlane.aggregate.mse, 2 / 3); assert.equal(onePlane.aggregate.psnr.kind, 'finite');
});

test('visible ROI maps through independent crops, strides and nonzero view offsets without padding samples', () => {
  for (const depth of [8, 10] as const) {
    const reference = frame(depth, { width: 4, height: 4, codedWidth: 8, codedHeight: 8, cropX: 2, cropY: 2, padding: 7, byteOffset: 13 });
    const distorted = frame(depth, { width: 4, height: 4, codedWidth: 10, codedHeight: 8, cropX: 4, cropY: 2, padding: 5, byteOffset: 3,
      value: (c, x, y) => x >= (c ? 3 : 6) && x < (c ? 4 : 8) && y >= (c ? 2 : 4) && y < (c ? 3 : 6) ? 19 : 200 });
    const result = measurePsnr(request(reference, distorted, { x: 2, y: 2, width: 2, height: 2 }));
    assert.deepEqual(Object.values(result.planes).map(p => [p.sse, p.samples]), [[36, 4], [9, 1], [9, 1]]);
    assert.equal(result.aggregate.sse, 54); assert.equal(result.aggregate.mse, 9);
    assert.equal(result.work.inputViewBytes, reference.pixels.byteLength + distorted.pixels.byteLength);
    assert.equal(result.work.chargedInputBytes, reference.pixels.buffer.byteLength + distorted.pixels.buffer.byteLength);
  }
});

test('mandatory ROI rejects empty, fractional, nonfinite, negative, out-of-bounds and unaligned requests', () => {
  for (const roi of [undefined, { x: -2, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 6, height: 2 }, { x: .5, y: 0, width: 2, height: 2 }, { x: NaN, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: Infinity, height: 2 }]) fails({ ...request(), roi: roi as PsnrRoi }, 'invalid-input', 'roi');
  for (const roi of [{ x: 1, y: 0, width: 2, height: 2 }, { x: 0, y: 1, width: 2, height: 2 },
    { x: 0, y: 0, width: 3, height: 2 }, { x: 0, y: 0, width: 2, height: 3 }]) fails(request(frame(), frame(), roi), 'unsupported-format', 'roi.chroma-alignment');
  const oddCrop = frame(8, { codedWidth: 6, cropX: 1 }); fails(request(oddCrop, frame()), 'unsupported-format', 'reference.chroma-alignment');
});

test('incompatible visible/display geometry, effective bit depth or actual color never becomes a comparable pair', () => {
  fails(request(frame(), frame(10)), 'incompatible-input');
  fails(request(frame(), frame(8, { width: 6 })), 'incompatible-input');
  fails(request(frame(), frame(8, { height: 6 })), 'incompatible-input');
  const display = frame(); display.description.displayWidth = 8; fails(request(frame(), display), 'incompatible-input');
  for (const change of [{ primaries: 'bt2020' }, { transfer: 'smpte170m' }, { matrix: 'smpte170m' }, { fullRange: true }]) {
    const b = frame(); Object.assign(b.description.color, change); fails(request(frame(), b), 'incompatible-input');
  }
  const siting = frame(); siting.description.yuv!.chromaLocation = 2; fails(request(frame(), siting), 'incompatible-input');
});

test('missing tags/siting, explicit HDR and unsupported color tags are reported without display defaults', () => {
  for (const field of ['primaries', 'transfer', 'matrix', 'fullRange'] as const) {
    const a = frame(); a.description.color[field] = null; fails(request(a), 'missing-color');
  }
  const siting = frame(); siting.description.yuv!.chromaLocation = 0; fails(request(siting), 'missing-color');
  const unsupportedSiting = frame(); unsupportedSiting.description.yuv!.chromaLocation = 7; fails(request(unsupportedSiting), 'unsupported-format');
  for (const transfer of ['smpte2084', 'arib-std-b67', 'unknown']) {
    const a = frame(10); a.description.color.transfer = transfer; fails(request(a, frame(10)), 'unsupported-format');
  }
  const rgb = frame(); rgb.description.color.matrix = 'rgb'; fails(request(rgb), 'unsupported-format');
});

test('unsupported layouts and domains are rejected, including shifted packing and shared/resizable storage', () => {
  for (const change of [{ semiplanar: true }, { subsampleX: 0 }, { subsampleY: 0 }, { bitDepth: 12 }, { bitShift: 6 }]) {
    const a = frame(10); Object.assign(a.description.yuv!, change); fails(request(a, frame(10)), 'unsupported-format');
  }
  for (const change of [{ format: 'RGBA' }, { byteLengthEstimated: true }, { colorFallback: 'swscale-rgba' }]) {
    const a = frame(); Object.assign(a.description, change); fails(request(a), 'unsupported-format');
  }
  fails({ ...request(), domain: 'display-rgb' as PsnrRequest['domain'] }, 'unsupported-format', 'domain');
  const shared = frame(); shared.pixels = new Uint8Array(new SharedArrayBuffer(shared.pixels.byteLength)); fails(request(shared), 'invalid-input');
  const resizable = frame();
  // Node 24 supports resizable buffers; the project's ES2023 type library predates the constructor option.
  resizable.pixels = new Uint8Array(Reflect.construct(ArrayBuffer, [resizable.pixels.byteLength, { maxByteLength: 64 }]));
  fails(request(resizable), 'unsupported-format');
});

test('malformed plane bounds, overlap, lengths and crop cannot read outside a buffer', () => {
  for (const mutate of [
    (a: PsnrFrame) => { a.description.yuv!.planes[0].stride = 1; },
    (a: PsnrFrame) => { a.description.yuv!.planes[1].offset = 0; },
    (a: PsnrFrame) => { a.description.yuv!.planes[2].offset = a.pixels.byteLength; },
    (a: PsnrFrame) => { a.description.yuv!.planes[0].width = 2; },
    (a: PsnrFrame) => { a.description.byteLength++; },
    (a: PsnrFrame) => { a.description.visibleRect.x = 2; },
  ]) { const a = frame(); mutate(a); fails(request(a), 'invalid-input'); }
});

test('input/sample limits reject before sample traversal; exact caller limits work and cannot raise hard caps', () => {
  const bad = frame(10); bad.pixels[0] = 255; bad.pixels[1] = 255;
  fails({ ...request(bad, frame(10)), budget: { maxSamples: 23 } }, 'budget-exceeded', 'samples');
  fails({ ...request(bad, frame(10)), budget: { maxInputBytes: 95 } }, 'budget-exceeded', 'inputBytes');
  const r = request(), bytes = r.reference.pixels.buffer.byteLength + r.distorted.pixels.buffer.byteLength;
  assert.equal(measurePsnr({ ...r, budget: { maxSamples: 24, maxInputBytes: bytes } }).aggregate.samples, 24);
  for (const maxSamples of [0, -1, .5, NaN, PSNR_LIMITS.maxSamples + 1]) fails({ ...r, budget: { maxSamples } }, 'invalid-input');
  fails({ ...r, budget: { maxInputBytes: PSNR_LIMITS.maxInputBytes + 1 } }, 'invalid-input');
  assert.equal(Number.isSafeInteger(PSNR_LIMITS.maxSamples * 1023 ** 2), true);
  assert.equal(Object.isFrozen(PSNR_LIMITS), true);
});

test('default hard limits bound retained input allocations, dimensions and total plane samples', () => {
  const large = frame(8, { width: 4096, height: 2732 });
  fails(request(large, large, { x: 0, y: 0, width: 4096, height: 2732 }), 'budget-exceeded', 'samples');
  const wide = frame(8, { width: 16386, height: 2 });
  fails(request(wide, wide, { x: 0, y: 0, width: 16386, height: 2 }), 'budget-exceeded', 'reference.dimensions');
  const backing = frame(); backing.pixels = new Uint8Array(new ArrayBuffer(64 * 1024 * 1024 + 1), 0, backing.pixels.byteLength);
  fails(request(backing, backing), 'budget-exceeded', 'inputBytes');
});

test('10-bit words outside effective depth are rejected rather than masked; only the selected ROI is certified', () => {
  const a = frame(10); a.pixels[0] = 255; a.pixels[1] = 255;
  fails(request(a, frame(10)), 'invalid-input', 'reference.sample');
  fails(request(frame(10), a), 'invalid-input', 'distorted.sample');
  assert.equal(measurePsnr(request(a, frame(10), { x: 2, y: 2, width: 2, height: 2 })).aggregate.sse, 0);
});

test('large 10-bit SSE remains exact beyond 32-bit integer range', () => {
  const a = frame(10, { width: 1024, height: 1024, value: () => 0 }), b = frame(10, { width: 1024, height: 1024, value: () => 1023 });
  const result = measurePsnr(request(a, b, { x: 0, y: 0, width: 1024, height: 1024 }));
  assert.equal(result.aggregate.sse, Number(1_572_864n * 1023n * 1023n));
  assert.equal(result.aggregate.mse, 1_046_529); assert.equal(db(result.aggregate.psnr), 0);
});

test('success and failure leave input pixels/descriptors unchanged; result metadata is detached', () => {
  const a = frame(), b = frame(8, { value: () => 17 }), r = request(a, b), before = structuredClone(r);
  const result = measurePsnr(r); assert.deepEqual(r, before);
  result.color.matrix = 'changed'; result.roi.x = 100; assert.deepEqual(r, before);
  const bad = request(frame(10), frame(10)); bad.distorted.pixels[0] = 255; bad.distorted.pixels[1] = 255;
  const failureBefore = structuredClone(bad); fails(bad, 'invalid-input'); assert.deepEqual(bad, failureBefore);
});
