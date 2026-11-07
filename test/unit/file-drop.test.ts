import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindFileDrop } from '../../src/ui/file-drop.ts';
import { dropSlots } from '../../shared/review/drop-slots.ts';
import type { Slot } from '../../shared/review/model.ts';
import { SLOTS } from '../../shared/review/model.ts';

test('file drop fills only vacant tracks and rejects insufficient capacity', () => {
  assert.deepEqual(dropSlots(1, []), ['A']);
  assert.deepEqual(dropSlots(1, ['A']), ['B']);
  assert.deepEqual(dropSlots(1, ['B']), ['A']);
  assert.deepEqual(dropSlots(1, ['A', 'B']), ['C']);
  assert.deepEqual(dropSlots(2, ['A']), ['B', 'C']);
  assert.deepEqual(dropSlots(4, []), ['A', 'B', 'C', 'D']);
  assert.deepEqual(dropSlots(8, []), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(dropSlots(1, ['A', 'B']), ['C']);
  assert.deepEqual(dropSlots(2, ['A', 'B', 'C']), ['D', 'E']);
  assert.deepEqual(dropSlots(1, ['A', 'B', 'C', 'D']), ['E']);
  assert.deepEqual(dropSlots(2, ['B', 'D', 'F', 'H']), ['A', 'C']);
  assert.deepEqual(dropSlots(1, SLOTS.slice(0, 7)), ['H']);
  assert.throws(() => dropSlots(2, SLOTS.slice(0, 7)), /当前有 1 条空轨道，无法添加 2 个视频/);
  assert.throws(() => dropSlots(1, [...SLOTS]), /当前有 0 条空轨道/);
  assert.throws(() => dropSlots(0, []));
  assert.throws(() => dropSlots(9, []));
});

function harness(initial: Slot[] = ['A']) {
  const root = new EventTarget();
  const loads: { files: File[]; slots: Slot[] }[] = [];
  const errors: unknown[] = [];
  let hover: Slot[] = [];
  let loaded = initial;
  const dispose = bindFileDrop(root, {
    loaded: () => loaded,
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
  return { root, send, dispose, loads, errors, setLoaded(slots: Slot[]) { loaded = slots; }, get hover() { return hover; } };
}

test('file drag prevents browser navigation, clears feedback, and snapshots dropped files', async () => {
  const h = harness(); const files = [new File(['a'], 'a.mp4'), new File(['b'], 'b.mp4')];
  const over = h.send('dragover', files);
  assert.equal(over.event.defaultPrevented, true); assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.deepEqual(h.hover, ['B', 'C']);
  const drop = h.send('drop', files);
  assert.equal(drop.event.defaultPrevented, true); assert.deepEqual(h.hover, []);
  files.length = 0; // Real DataTransfer access is protected after dispatch.
  await new Promise<void>(resolve => setImmediate(resolve)); // Handle capture finishes before the async load callback.
  assert.deepEqual(h.loads[0].files.map(file => file.name), ['a.mp4', 'b.mp4']);
  assert.deepEqual(h.loads[0].slots, ['B', 'C']);
  h.dispose();
});

test('text drags stay native; empty and oversized file drops do not load anything', async () => {
  const h = harness();
  assert.equal(h.send('drop', [], ['text/plain']).event.defaultPrevented, false);
  h.send('drop', []);
  h.send('drop', [1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => new File(['a'], `${i}.mp4`)));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.loads.length, 0); assert.equal(h.errors.length, 2);
  h.dispose();
});

test('insufficient and full tracks refuse the whole drop without loading or throwing during hover', async () => {
  for (const loaded of [SLOTS.slice(0, 7), [...SLOTS]]) {
    const h = harness(loaded), files = [new File(['a'], 'a.mp4'), new File(['b'], 'b.mp4')];
    const over = h.send('dragover', files);
    assert.equal(over.event.defaultPrevented, true);
    assert.deepEqual(h.hover, []); assert.equal(h.errors.length, 0);
    h.send('drop', files);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.loads.length, 0); assert.equal(h.errors.length, 1);
    assert.match(String(h.errors[0]), new RegExp(`当前有 ${8 - loaded.length} 条空轨道`));
    h.dispose();
  }
});

test('a track filled during handle capture is never reused by the drop', async () => {
  const h = harness(), files = [new File(['a'], 'a.mp4')];
  h.send('drop', files); h.setLoaded(['A', 'B']);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.loads[0].slots, ['C']);
  h.dispose();
  const full = harness(SLOTS.slice(0, 7));
  full.send('drop', files); full.setLoaded([...SLOTS]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(full.loads.length, 0); assert.match(String(full.errors[0]), /当前有 0 条空轨道/);
  full.dispose();
});

test('workspace documents still use the import path when all video tracks are occupied', async () => {
  const root = new EventTarget(), file = new File(['workspace'], 'review.voidplayer');
  const imports: File[][] = [], errors: unknown[] = [];
  const dispose = bindFileDrop(root, {
    document: { accepts: files => files[0]?.name.endsWith('.voidplayer'), load: async files => { imports.push(files); } },
    loaded: () => [...SLOTS], hover: () => {},
    load: async () => { assert.fail('workspace drops must not enter the video allocator'); }, error: error => errors.push(error),
  });
  const event = new Event('drop', { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
  root.dispatchEvent(event);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true); assert.deepEqual(imports, [[file]]); assert.deepEqual(errors, []);
  dispose();
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

test('Escape and dragend remove external file feedback without loading files', () => {
  const h = harness(), files = [new File(['a'], 'a.mp4')];
  h.send('dragenter', files); assert.deepEqual(h.hover, ['B']);
  const escape = new Event('keydown'); Object.defineProperty(escape, 'key', { value: 'Escape' }); h.root.dispatchEvent(escape);
  assert.deepEqual(h.hover, []);
  h.send('dragenter', files); h.send('dragend', files);
  assert.deepEqual(h.hover, []); assert.equal(h.loads.length, 0); h.dispose();
});

test('mixed drop skips non-videos before allocating slots and keeps the right file handle', async () => {
  const root = new EventTarget(), errors: unknown[] = [], loaded: unknown[] = [];
  const video = new File([Uint8Array.of(0x1a,0x45,0xdf,0xa3)], 'clip-without-extension');
  const image = new File(['png'], 'image.png'), handle = {kind:'file',name:video.name};
  const dispose = bindFileDrop(root, {
    loaded:() => SLOTS.slice(0,7), hover:()=>{}, error:e=>errors.push(e),
    load:async(files, slots, handles)=>{loaded.push({files, slots, handles});},
  });
  const event = new Event('drop',{cancelable:true});
  Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:[image,video],items:[
    {kind:'file',getAsFile:()=>image},
    {kind:'file',getAsFile:()=>null,getAsFileSystemHandle:async()=>({kind:'directory',name:'games'})},
    {kind:'file',getAsFile:()=>null,webkitGetAsEntry:()=>({isDirectory:true,name:'Tool.app'})},
    {kind:'file',getAsFile:()=>video,getAsFileSystemHandle:async()=>handle},
  ]}});
  root.dispatchEvent(event);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(loaded,[{files:[video],slots:['H'],handles:[handle]}]);
  assert.equal(errors.length,1);assert.match(String(errors[0]),/3 个.*image.png/);
  assert.equal(event.defaultPrevented,true);
  dispose();
});
