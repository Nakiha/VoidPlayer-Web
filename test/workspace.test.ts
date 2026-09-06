import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceState, marksForTrack, trackTiming } from '../src/ui/workspace-state.ts';
import type { ReviewTrack } from '../src/ui/workspace-state.ts';
import { SourceCatalog, sourceInUse } from '../src/ui/source-catalog.ts';
import type { Mark } from '../src/model.ts';

const track: ReviewTrack = { id: 'new', slot: 'A', name: 'clip.mp4', size: 10, lastModified: 1,
  codec: 'avc1', decoder: 'webcodecs', width: 1920, height: 1080, durationUs: 1000000, firstPtsUs: 10000,
  frame: { ptsUs: 100000, sourcePtsUs: 110000, durationUs: 33333 } };

test('clean default and independent panel selection do not lose the active inspection track', () => {
  const state = new WorkspaceState();
  assert.deepEqual(state.panels, { inspector: false, subtracks: false, sources: false });
  state.selected = 'B';
  state.setPanel('inspector', true, 1440); state.setPanel('subtracks', true, 1440); state.setPanel('sources', true, 1440);
  assert.ok(Object.values(state.panels).every(Boolean));
  state.setPanel('inspector', false); state.setPanel('inspector', true);
  assert.equal(state.selected, 'B');
  state.reconcile([track]); assert.equal(state.selected, 'A');
});
test('narrow layout retains both independently opened side panels and the dock', () => {
  const state = new WorkspaceState(); state.setPanel('subtracks', true, 700);
  state.setPanel('inspector', true, 700); state.setPanel('sources', true, 700);
  assert.deepEqual(state.panels, { inspector: true, sources: true, subtracks: true });
});
test('marks are anchored to media identity, not a reusable A/B slot', () => {
  const make = (id: string, mediaId: string, ptsUs: number) => ({ id, mediaId, slot: 'A', frame: { ptsUs } }) as Mark;
  const marks = [make('old-note', 'old', 0), make('later', 'new', 200), make('earlier', 'new', 100)];
  assert.deepEqual(marksForTrack(track, marks).map(m => m.id), ['earlier', 'later']);
  assert.deepEqual(marks.map(m => m.id), ['old-note', 'later', 'earlier']);
});
test('frame quantization is displayed separately from a synchronization offset', () => {
  assert.deepEqual(trackTiming(track, 120000), { offsetUs: 0, frameDeltaUs: -20000 });
  assert.deepEqual(trackTiming({ ...track, frame: null }, 120000), { offsetUs: 0, frameDeltaUs: null });
});
test('local file history cannot imply access after a browser restart', () => {
  const file = new File(['sample'], 'clip.mp4', { lastModified: 1 });
  const catalog = new SourceCatalog(); catalog.addFile(file); catalog.addFile(file);
  assert.equal(catalog.available().length, 1); assert.equal(catalog.recent().length, 1);
  assert.equal(catalog.recent()[0].file, file);
  const restored = new SourceCatalog(catalog.serializable());
  assert.equal(restored.available().length, 0); assert.equal(restored.recent()[0].file, undefined);
  assert.equal(restored.recent()[0].library, undefined);
  restored.addFile(file); assert.equal(restored.recent()[0].file, file);
});
test('library history reconnects only to matching metadata, and rejects a replaced file', () => {
  const entry = { id: 'library-1', name: 'clip.mp4', root: 'samples', size: 10, lastModified: 1 };
  const catalog = new SourceCatalog(); catalog.setLibrary([entry]); catalog.remember(entry, entry.id);
  const restored = new SourceCatalog(catalog.serializable()); restored.setLibrary([entry]);
  assert.equal(restored.recent()[0].library?.id, entry.id);
  restored.setLibrary([{ ...entry, size: 20 }]); assert.equal(restored.recent()[0].library, undefined);
  restored.setLibrary([]); assert.equal(restored.available().length, 0);
});
test('same-metadata library sources survive listing, history and restart as distinct identities', () => {
  const metadata = { name: 'same.mp4', size: 123, lastModified: 456 };
  const entries = ['a', 'b'].map(root => ({ ...metadata, id: `root-${root}`, root }));
  const catalog = new SourceCatalog(); catalog.setLibrary(entries);
  assert.deepEqual(catalog.available().map(item => item.library?.id), ['root-a', 'root-b']);
  assert.equal(new Set(catalog.available().map(item => item.key)).size, 2);
  for (const entry of entries) catalog.remember(entry, entry.id);
  // Older v1 histories used the metadata-only key. Their explicit IDs still migrate.
  const oldKey = JSON.stringify([metadata.name, metadata.size, metadata.lastModified]);
  const restored = new SourceCatalog(catalog.serializable().map(item => ({ ...item, key: oldKey })));
  restored.setLibrary(entries);
  assert.deepEqual(restored.recent().map(item => item.library?.id), ['root-b', 'root-a']);
  restored.setLibrary([entries[0]]);
  assert.equal(restored.recent()[0].library, undefined);
  assert.equal(restored.recent()[1].library?.id, 'root-a');
});
test('local and library sources with identical metadata never substitute for each other', () => {
  const file = new File(['sample'], 'same.mp4', { lastModified: 456 });
  const entry = { id: 'library-a', root: 'library', name: file.name, size: file.size, lastModified: file.lastModified };
  const catalog = new SourceCatalog(); catalog.setLibrary([entry]);
  catalog.remember(entry, entry.id); catalog.addFile(file);
  const [local, remote] = catalog.available();
  assert.equal(local.file, file); assert.equal(local.library, undefined);
  assert.equal(remote.library?.id, entry.id); assert.equal(remote.file, undefined);
  const loadedLocal = { ...track, name: file.name, size: file.size, lastModified: file.lastModified };
  const loadedLibrary = { ...loadedLocal, source: { kind: 'library' as const, id: entry.id, url: '/api/media/library-a' } };
  assert.equal(sourceInUse(local, [loadedLocal]), true);
  assert.equal(sourceInUse(remote, [loadedLocal]), false);
  assert.equal(sourceInUse(local, [loadedLibrary]), false);
  assert.equal(sourceInUse(remote, [loadedLibrary]), true);
  const restored = new SourceCatalog(catalog.serializable()); restored.setLibrary([entry]);
  assert.equal(restored.recent()[0].file, undefined);
  assert.equal(restored.recent()[0].library, undefined);
  assert.equal(restored.recent()[1].library?.id, entry.id);
  restored.setLibrary([{ ...entry, size: entry.size + 1 }]); restored.addFile(file);
  assert.equal(restored.recent()[1].library, undefined);
  assert.equal(restored.recent()[1].file, undefined);
});
test('history sanitizes storage, remains bounded, and exposes detached metadata', () => {
  const catalog = new SourceCatalog([null, { name: 'invalid', size: -1, lastModified: 1 }]);
  for (let i = 0; i < 60; i++) catalog.remember({ name: `clip-${i}`, size: i, lastModified: 1 });
  assert.equal(catalog.recent().length, 40);
  const stored = catalog.serializable(); stored[0].name = 'mutated';
  assert.equal(catalog.recent()[0].name, 'clip-59');
});


test('track drop gaps and trailing blank space select the nearest row', async () => {
  const { nearestTrackIndex } = await import('../src/ui/workspace-state.ts');
  const rows = [{ top: 32, bottom: 64 }, { top: 66, bottom: 98 }, { top: 100, bottom: 132 }, { top: 134, bottom: 166 }];
  assert.equal(nearestTrackIndex(420, rows), 3);
  assert.equal(nearestTrackIndex(0, rows), 0);
  assert.equal(nearestTrackIndex(99, rows), 1);
  assert.equal(nearestTrackIndex(115, rows), 2);
  assert.equal(nearestTrackIndex(150, []), -1);
  assert.equal(nearestTrackIndex(NaN, rows), -1);
});

test('side panel bounds preserve comparison room and fit narrow windows', async () => {
  const { panelWidthBounds } = await import('../src/ui/panel-resize.ts');
  assert.deepEqual(panelWidthBounds(1000, 400, false), {min:160,max:240});
  assert.deepEqual(panelWidthBounds(600, 0, true), {min:160,max:450});
  assert.deepEqual(panelWidthBounds(200, 0, true), {min:150,max:150});
});


test('used library entries match source IDs, not same-named files in other roots', async () => {
  const { sourceInUse, sourceKey } = await import('../src/ui/source-catalog.ts');
  const metadata = {name:'same.mp4',size:123,lastModified:456};
  const item = {...metadata,key:sourceKey(metadata),libraryId:'root-a-file'};
  const loaded = {...metadata,id:'decoded-id',source:{kind:'library' as const,id:'root-a-file',url:'/api/media/root-a-file'}} as import('../src/model.ts').MediaInfo;
  assert.equal(sourceInUse(item, [loaded]), true);
  assert.equal(sourceInUse({...item,libraryId:'root-b-file'}, [loaded]), false);
  assert.equal(sourceInUse(item, []), false);
  const local = {...loaded,source:undefined};
  assert.equal(sourceInUse({...metadata,key:sourceKey(metadata)},[local]), true);
});


test('panel collapse needs deliberate overshoot on either side and reverses before release', async () => {
  const { panelDragIntent } = await import('../src/ui/panel-resize.ts');
  const bounds = {min:160,max:480};
  assert.deepEqual(panelDragIntent(240,-80,1,bounds,32), {width:160,collapse:false});
  assert.deepEqual(panelDragIntent(240,-111,1,bounds,32), {width:160,collapse:false});
  assert.deepEqual(panelDragIntent(240,-112,1,bounds,32), {width:160,collapse:true});
  assert.deepEqual(panelDragIntent(240,112,-1,bounds,32), {width:160,collapse:true});
  assert.deepEqual(panelDragIntent(240,70,-1,bounds,32), {width:170,collapse:false});
  assert.deepEqual(panelDragIntent(240,500,1,bounds,32), {width:480,collapse:false});
  assert.deepEqual(panelDragIntent(120,-32,1,{min:120,max:120},32), {width:120,collapse:true});
});
