import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRgba, summarizeRgba } from '../src/color-evidence.ts';

test('RGB evidence measures signed channel shifts and ignores alpha', () => {
  const a = new Uint8ClampedArray([0, 100, 255, 0, 20, 40, 60, 255]);
  const b = new Uint8ClampedArray([10, 90, 255, 255, 30, 30, 60, 0]);
  const diff = compareRgba(a, b);
  assert.equal(diff.mae, 40 / 6); assert.equal(diff.rmse, Math.sqrt(400 / 6));
  assert.equal(diff.max, 10); assert.equal(diff.differentPixels, 2);
  assert.deepEqual(diff.meanSignedRgb, [10, -10, 0]);
  assert.deepEqual(summarizeRgba(a).rgb[0], { mean: 10, min: 0, max: 20, zeros: 1, saturated: 0 });
  assert.equal(summarizeRgba(a).rgb[2].saturated, 1);
  assert.equal(compareRgba(a, a).mae, 0);
});

test('invalid evidence buffers do not produce reassuring NaN or partial statistics', () => {
  assert.throws(() => summarizeRgba(new Uint8ClampedArray()));
  assert.throws(() => compareRgba(new Uint8ClampedArray(4), new Uint8ClampedArray(8)));
  assert.throws(() => summarizeRgba(new Uint8ClampedArray(3)));
});
