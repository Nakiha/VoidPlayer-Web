import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindFileDrop, dropSlots } from '../src/file-drop.ts';
import type { Slot } from '../src/model.ts';

test('file drop targets explicit tracks, fills empty slots, and rejects overflow before loading', () => {
  assert.deepEqual(dropSlots(1, []), ['A']);
  assert.deepEqual(dropSlots(1, ['A']), ['B']);
  assert.deepEqual(dropSlots(1, ['B']), ['A']);
  assert.deepEqual(dropSlots(1, ['A', 'B'], 'A'), ['A']);
  assert.deepEqual(dropSlots(2, ['A'], 'B'), ['A', 'B']);
  assert.throws(() => dropSlots(0, []));
  assert.throws(() => dropSlots(3, []));
});

function harness() {
  const root = new EventTarget();
  const loads: { files: File[]; slots: Slot[] }[] = [];
  const errors: unknown[] = [];
  let hover: Slot[] = [];
  const dispose = bindFileDrop(root, {
    target: () => undefined, loaded: () => ['A'],
    hover: slots => { hover = slots; },
    load: async (files, slots) => { loads.push({ files, slots }); },
    error: error => errors.push(error),
  });
  const send = (type: string, files: File[], types = ['Files']) => {
    const event = new Event(type, { cancelable: true });
    const dataTransfer = { types, files, items: files.map(() => ({ kind: 'file' })), dropEffect: 'none' };
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    root.dispatchEvent(event);
    return { event, dataTransfer };
  };
  return { send, dispose, loads, errors, get hover() { return hover; } };
}

test('file drag prevents browser navigation, clears feedback, and snapshots dropped files', () => {
  const h = harness(); const files = [new File(['a'], 'a.mp4'), new File(['b'], 'b.mp4')];
  const over = h.send('dragover', files);
  assert.equal(over.event.defaultPrevented, true); assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.deepEqual(h.hover, ['A', 'B']);
  const drop = h.send('drop', files);
  assert.equal(drop.event.defaultPrevented, true); assert.deepEqual(h.hover, []);
  files.length = 0; // Real DataTransfer access is protected after dispatch.
  assert.deepEqual(h.loads[0].files.map(file => file.name), ['a.mp4', 'b.mp4']);
  assert.deepEqual(h.loads[0].slots, ['A', 'B']);
  h.dispose();
});

test('text drags stay native; empty and oversized file drops do not load anything', () => {
  const h = harness();
  assert.equal(h.send('drop', [], ['text/plain']).event.defaultPrevented, false);
  h.send('drop', []);
  h.send('drop', [1, 2, 3].map(i => new File(['a'], `${i}.mp4`)));
  assert.equal(h.loads.length, 0); assert.equal(h.errors.length, 2);
  h.dispose();
});

test('nested drag targets keep feedback until exit; cleanup removes event handlers', () => {
  const h = harness(); const files = [new File(['a'], 'a.mp4')];
  h.send('dragenter', files); h.send('dragenter', files); h.send('dragleave', files);
  assert.deepEqual(h.hover, ['B']);
  h.send('dragleave', files); assert.deepEqual(h.hover, []);
  h.dispose();
  assert.equal(h.send('drop', files).event.defaultPrevented, false);
  assert.equal(h.loads.length, 0);
});
