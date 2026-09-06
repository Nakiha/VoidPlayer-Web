import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekTarget } from '../src/ui/seek-preview.ts';
const marks = [{ id: 'one', text: 'one second', frame: { ptsUs: 1000000 } }, { id: 'two', text: 'two seconds', frame: { ptsUs: 2000000 } }];
test('subtrack clicks at 1.01s snap to the exact 1s annotation anchor', () => {
  assert.equal(seekTarget(101, 1000, 10000000, marks).ptsUs, 1000000);
  assert.equal(seekTarget(120, 1000, 10000000, marks).ptsUs, 1200000);
  assert.equal(seekTarget(101, 1000, 10000000).ptsUs, 1010000);
});
test('snap radius scales with pixel width and ties choose the earlier anchor', () => {
  assert.equal(seekTarget(52, 500, 10000000, marks).ptsUs, 1000000);
  const close = [...marks, { id: 'next', text: 'next', frame: { ptsUs: 1100000 } }];
  assert.equal(seekTarget(105, 1000, 10000000, close).ptsUs, 1000000);
  assert.equal(seekTarget(-20, 1000, 10000000, marks).ptsUs, 0);
  assert.equal(seekTarget(1200, 1000, 10000000, marks).ptsUs, 10000000);
  assert.equal(seekTarget(1, 0, 0, marks).ptsUs, 0);
});
