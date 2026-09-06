import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameTask } from '../src/ui/frame-task.ts';

test('layout updates coalesce, use the latest state, and defer reentrant work to another frame', () => {
  let sequence = 0, value = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const seen: number[] = [];
  const task = createFrameTask(() => {
    seen.push(value);
    if (value === 2) { value = 3; task.schedule(); }
  }, { request(callback) { callbacks.set(++sequence, callback); return sequence; }, cancel(id) { callbacks.delete(id); } });
  const frame = () => {
    const ready = [...callbacks.values()]; callbacks.clear();
    ready.forEach(callback => callback(0));
  };
  value = 1; task.schedule(); value = 2; task.schedule(); task.schedule();
  assert.equal(callbacks.size, 1); assert.deepEqual(seen, []);
  frame(); assert.deepEqual(seen, [2]); assert.equal(callbacks.size, 1);
  frame(); assert.deepEqual(seen, [2, 3]); assert.equal(callbacks.size, 0);
  task.schedule(); task.dispose(); task.schedule();
  assert.equal(callbacks.size, 0); frame(); assert.deepEqual(seen, [2, 3]);
});
