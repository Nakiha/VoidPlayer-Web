import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsViewRecovery } from '../../src/ui/view-recovery.ts';
const view = { width: 800, height: 600, imageWidth: 800, imageHeight: 450, zoom: 1, offsetX: 0, offsetY: 0 };
test('recovery appears only after the video leaves the visible viewport', () => {
  assert.equal(needsViewRecovery(view), false);
  assert.equal(needsViewRecovery({ ...view, offsetX: 799 }), false);
  assert.equal(needsViewRecovery({ ...view, offsetX: 801 }), true);
  assert.equal(needsViewRecovery({ ...view, offsetY: -600 }), true);
  assert.equal(needsViewRecovery({ ...view, zoom: 4, offsetX: 801 }), false);
});
test('a smaller image needs recovery only after it leaves the whole stage', () => {
  const small = { ...view, imageWidth: 200 };
  assert.equal(needsViewRecovery(small), false);
  for (const direction of [-1, 1]) {
    assert.equal(needsViewRecovery({ ...small, offsetX: direction * 499 }), false);
    assert.equal(needsViewRecovery({ ...small, offsetX: direction * 500 }), true);
  }
});
