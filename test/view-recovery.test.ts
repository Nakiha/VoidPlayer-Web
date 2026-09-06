import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsViewRecovery } from '../src/ui/view-recovery.ts';
const view = { width: 800, height: 600, imageWidth: 800, imageHeight: 450, zoom: 1, offsetX: 0, offsetY: 0 };
test('recovery appears only after the video leaves the visible viewport', () => {
  assert.equal(needsViewRecovery(view), false);
  assert.equal(needsViewRecovery({ ...view, offsetX: 799 }), false);
  assert.equal(needsViewRecovery({ ...view, offsetX: 801 }), true);
  assert.equal(needsViewRecovery({ ...view, offsetY: -600 }), true);
  assert.equal(needsViewRecovery({ ...view, zoom: 4, offsetX: 801 }), false);
});
test('recovery accounts for the clipped portion of a split view', () => {
  const small = { ...view, imageWidth: 200 };
  assert.equal(needsViewRecovery(small, 0, .2), true);
  assert.equal(needsViewRecovery(small, .2, 1), false);
});
