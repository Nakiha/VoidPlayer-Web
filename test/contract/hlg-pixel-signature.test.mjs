import test from 'node:test';
import assert from 'node:assert/strict';
import { createHlgPixelSampler, hlgSignatureDifference, hlgSignatureHasSpatialVariation } from '../../scripts/hlg-pixel-signature.mjs';

const native = (format, bytes, stride = bytes.length, width = 1, height = 1) => ({ frame: {
  format, visibleRect: { x: 0, y: 0, width, height }, allocationSize: () => bytes.length,
  copyTo: async destination => { destination.set(bytes); return [{ offset: 0, stride }]; },
} });

test('HLG native P010 is little-endian and MSB-aligned, unlike planar 10-bit', async () => {
  const sample = createHlgPixelSampler();
  const planar = await sample(native('I420P10', Uint8Array.of(1, 3)));
  const p010 = await sample(native('P010', Uint8Array.of(64, 192)));
  assert.equal(planar.values.length, 32 * 18);
  assert.equal(planar.values[0], 769 / 4);
  assert.deepEqual(p010.values, planar.values);
  assert.equal(p010.shift, 6); assert.equal(planar.shift, 0);
  assert.equal(p010.readbackPath, 'native-copy-luma');
});

test('native copy signatures honor layout padding and visible dimensions', async () => {
  const output = native('I420P12', Uint8Array.of(0, 8, 0, 15, 99, 99, 0, 4, 0, 1), 6, 2, 2);
  const signature = await createHlgPixelSampler()(output);
  assert.equal(signature.values[0], 128);
  assert.equal(signature.values[31], 240);
  assert.equal(signature.values.at(-32), 64);
  assert.equal(signature.values.at(-1), 16);
});

test('WASM luma signatures honor visible crop, byte offset, stride and high bit depth', async () => {
  const bytes = new Uint8Array(64).fill(255);
  const view = new DataView(bytes.buffer);
  for (const [x, y, value] of [[1, 1, 64], [2, 1, 128], [1, 2, 256], [2, 2, 512]]) view.setUint16(4 + y * 12 + x * 2, value, true);
  const signature = await createHlgPixelSampler()({ pixels: bytes.buffer, description: {
    format: 'yuv420p10le', visibleRect: { x: 1, y: 1, width: 2, height: 2 },
    yuv: { bitDepth: 10, bitShift: 0, planes: [{ offset: 4, stride: 12, width: 4, height: 4 }] },
  } });
  assert.equal(signature.readbackPath, 'wasm-luma');
  assert.equal(signature.values[0], 16); assert.equal(signature.values[31], 32);
  assert.equal(signature.values.at(-32), 64); assert.equal(signature.values.at(-1), 128);
});

test('opaque native frames use explicitly browser-managed sRGB readback and clear before each draw', async () => {
  const calls = [];
  const frame = { format: null, visibleRect: { width: 1, height: 1 }, allocationSize() { throw Error('must not copy opaque data'); } };
  const sample = createHlgPixelSampler({ createCanvas: (width, height) => {
    calls.push('create');
    return { width, height, getContext(kind, options) {
      assert.equal(kind, '2d'); assert.equal(options.colorSpace, 'srgb');
      return {
        clearRect() { calls.push('clear'); },
        drawImage(value) { assert.equal(value, frame); calls.push('draw'); },
        getImageData() { calls.push('read'); return { data: Uint8ClampedArray.of(24, 80, 201, 255) }; },
      };
    } };
  } });
  const first = await sample({ frame }), second = await sample({ frame });
  assert.equal(first.outputFormat, null);
  assert.equal(first.readbackPath, 'browser-managed-canvas2d-srgb');
  assert.equal(first.sampleFormat, 'RGBA'); assert.equal(first.depth, 8);
  assert.equal(first.values.length, 32 * 18 * 3);
  assert.deepEqual(first.values.slice(0, 3), [24, 80, 201]);
  assert.equal(hlgSignatureDifference(first, second), 0);
  assert.deepEqual(calls, ['create', 'clear', 'draw', 'read', 'clear', 'draw', 'read']);
});

test('opaque no-op draw and unavailable Canvas 2D readback fail rather than skipping pixels', async () => {
  const output = { frame: { format: null, visibleRect: { width: 1, height: 1 } } };
  const sample = createHlgPixelSampler({ createCanvas: () => ({ width: 1, height: 1, getContext: () => ({
    clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }) }) });
  await assert.rejects(sample(output), /produced transparent pixels/);
  await assert.rejects(createHlgPixelSampler({ createCanvas: () => ({ getContext: () => null }) })(output), /requires Canvas 2D readback/);
});

test('unsupported output formats and invalid copy layouts fail immediately', async () => {
  const sample = createHlgPixelSampler();
  await assert.rejects(sample(native('future-pixel-format', Uint8Array.of(0))), /unsupported native format/);
  await assert.rejects(sample({ description: { format: null } }), /unsupported output format null/);
  await assert.rejects(sample(native('I420', Uint8Array.of(0), 2, 2)), /exceeds buffer/);
  await assert.rejects(sample(native('I420P10', Uint8Array.of(255, 255))), /exceeds declared bit depth/);
});

test('identity comparison rejects mismatched resource paths or formats and non-finite samples', async () => {
  const signature = await createHlgPixelSampler()(native('RGBA', Uint8Array.of(10, 20, 30, 255)));
  assert.throws(() => hlgSignatureDifference(signature, { ...signature, outputFormat: 'BGRA' }), /outputFormat changed/);
  assert.throws(() => hlgSignatureDifference(signature, { ...signature, readbackPath: 'browser-managed-canvas2d-srgb' }), /readbackPath changed/);
  assert.throws(() => hlgSignatureDifference(signature, { ...signature, values: [] }), /signature length changed/);
  assert.throws(() => hlgSignatureDifference(signature, { ...signature, values: signature.values.map(() => NaN) }), /non-finite signature/);
  assert.equal(hlgSignatureDifference(signature, { ...signature, values: signature.values.map(value => value + 2) }), 2);
});

test('solid color frames do not masquerade as spatial picture variation', async () => {
  const sample = createHlgPixelSampler();
  const red = await sample(native('RGBA', Uint8Array.of(255, 0, 0, 255)));
  const varied = await sample(native('RGBA', Uint8Array.of(255, 0, 0, 255, 128, 0, 0, 255), 8, 2));
  assert.equal(hlgSignatureHasSpatialVariation(red), false);
  assert.equal(hlgSignatureHasSpatialVariation(varied), true);
});
