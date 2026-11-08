import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WheelGesture, Viewport, unobscuredFitArea, fitReference, wheelZoomFactor, ZOOM_MAX, fitContain, fittedSize, gridArrangement, normalizeWheelDelta,
} from '../../shared/presentation/viewport.ts';

test('grid keeps the first four tracks in a two-by-two reading order', () => {
  for (const count of [1, 2, 3, 4]) {
    const tracks = Array.from({ length: count }, () => ({ width: 1920, height: 1080 }));
    const layout = gridArrangement(1600, 900, tracks, 'uniform', 32, 36);
    assert.equal(layout.columns, Math.min(2, count));
    assert.equal(layout.rows, Math.ceil(count / 2));
    assert.deepEqual(layout.cells.map(cell => [cell.column, cell.row, cell.bottomHeading]),
      [[0, 0, false], [1, 0, false], [0, 1, true], [1, 1, true]].slice(0, count));
  }
});

test('five to eight tracks keep grouped order and repeat header placement in both directions', () => {
  for (const count of [5, 6, 7, 8]) {
    const tracks = Array.from({ length: count }, () => ({ width: 1920, height: 1080 }));
    const wide = gridArrangement(4000, 900, tracks, 'uniform', 32, 36);
    const tall = gridArrangement(800, 1600, tracks, 'uniform', 32, 36);
    assert.equal(wide.direction, 'horizontal');
    assert.equal(tall.direction, 'vertical');
    assert.equal(wide.columns, count === 5 ? 3 : 4);
    assert.equal(tall.rows, count <= 6 ? 3 : 4);
    assert.deepEqual(wide.cells.map(cell => [cell.column, cell.row]),
      [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [3, 0], [2, 1], [3, 1]].slice(0, count));
    assert.deepEqual(tall.cells.map(cell => [cell.column, cell.row]),
      [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2], [0, 3], [1, 3]].slice(0, count));
    for (const layout of [wide, tall]) {
      assert.deepEqual(layout.cells.map(cell => cell.bottomHeading), [false, false, true, true, false, false, true, true].slice(0, count));
      for (const cell of layout.cells) assert.equal(cell.bottomRow, cell.row === layout.rows - 1);
    }
  }
});

test('grid selection uses source aspect ratio, pixel density policy and a stable resize margin', () => {
  const hd = Array.from({ length: 8 }, () => ({ width: 1920, height: 1080 }));
  const cinema = hd.map(() => ({ width: 3840, height: 800 }));
  assert.equal(gridArrangement(1600, 900, hd, 'uniform', 32, 36).direction, 'horizontal');
  assert.equal(gridArrangement(1600, 900, cinema, 'uniform', 32, 36).direction, 'vertical');
  const mixed = hd.map((track, index) => index < 4 ? track : { width: 720, height: 1280 });
  assert.equal(gridArrangement(800, 900, mixed, 'uniform', 32, 36).direction, 'vertical');
  assert.equal(gridArrangement(800, 900, mixed, 'fill', 32, 36).direction, 'horizontal');
  for (const direction of ['horizontal', 'vertical'] as const) {
    assert.equal(gridArrangement(1088, 900, hd, 'uniform', 32, 36, direction).direction, direction, 'near ties retain direction');
  }
  assert.equal(gridArrangement(1250, 900, hd, 'uniform', 32, 36, 'vertical').direction, 'horizontal');
});

test('fitContain letterboxes without upscaling past the slot', () => {
  assert.deepEqual(fitContain(2000, 1000, 3840, 2160), { width: 1777.7777777777778, height: 1000 });
  assert.deepEqual(fitContain(2000, 1000, 1280, 720), { width: 1777.7777777777778, height: 1000 });
  const portrait = fitContain(2000, 1000, 720, 1280);
  assert.deepEqual(portrait, { width: 562.5, height: 1000 });
  const wide = fitContain(1000, 500, 3840, 2160);
  assert.deepEqual(wide, { width: 888.8888888888889, height: 500 });
});

test('uniform pixel mode gives every track the same screen size per video pixel', () => {
  const slot = { slotW: 2000, slotH: 1000 };
  const uhd = { ...slot, videoW: 3840, videoH: 2160 };
  const hd = { ...slot, videoW: 1280, videoH: 720 };
  const a = fittedSize(uhd, uhd, 'uniform');
  const b = fittedSize(hd, uhd, 'uniform');
  // Same density: displayed pixels per video pixel match across tracks.
  assert.ok(Math.abs(a.width / 3840 - b.width / 1280) < 1e-9);
  assert.ok(Math.abs(a.height / 2160 - b.height / 720) < 1e-9);
  // The reference (most pixels) fills its slot; the 720p track shrinks 3x.
  assert.ok(Math.abs(b.width - 1280 * (a.width / 3840)) < 1e-9);
  // fill mode ignores the reference.
  assert.deepEqual(fittedSize(hd, uhd, 'fill'), fitContain(2000, 1000, 1280, 720));
});

test('zoomAt keeps the content point under the cursor fixed', () => {
  const v = new Viewport();
  v.panBy(120, -40);
  const anchor = { x: 300, y: 160 };
  const before = { zoom: v.zoom, x: v.offsetX, y: v.offsetY };
  const contentX = (anchor.x - before.x) / before.zoom;
  const contentY = (anchor.y - before.y) / before.zoom;
  assert.equal(v.zoomAt(2.5, anchor.x, anchor.y), true);
  const afterX = (anchor.x - v.offsetX) / v.zoom;
  const afterY = (anchor.y - v.offsetY) / v.zoom;
  assert.ok(Math.abs(afterX - contentX) < 1e-9);
  assert.ok(Math.abs(afterY - contentY) < 1e-9);
});

test('zoom clamps to [1, 500] and returning to 1x re-centers', () => {
  const v = new Viewport();
  v.panBy(400, 300);
  v.zoomAt(1000, 10, 10);
  assert.equal(v.zoom, ZOOM_MAX);
  v.zoomAt(0.000001, 10, 10);
  assert.equal(v.zoom, 1);
  assert.equal(v.offsetX, 0);
  assert.equal(v.offsetY, 0);
  // Invalid factors are ignored.
  assert.equal(v.zoomAt(0), false);
  assert.equal(v.zoomAt(NaN), false);
});

test('setZoom anchors at the view center and 1x re-centers', () => {
  const v = new Viewport();
  v.panBy(100, 50);
  v.setZoom(2);
  assert.equal(v.zoom, 2);
  assert.equal(v.offsetX, 200); // factor * offset, anchor 0
  assert.equal(v.offsetY, 100);
  v.setZoom(1);
  assert.deepEqual([v.zoom, v.offsetX, v.offsetY], [1, 0, 0]);
});

test('pan is unbounded and accumulates', () => {
  const v = new Viewport();
  v.panBy(50, -20);
  v.panBy(10000, 5);
  assert.deepEqual([v.offsetX, v.offsetY], [10050, -15]);
  v.panBy(NaN, 0);
  assert.deepEqual([v.offsetX, v.offsetY], [10050, -15]);
});

test('rescaleOffset keeps the view center proportional across relayouts', () => {
  const v = new Viewport();
  v.zoomAt(2.5, 0, 0);
  v.panBy(120, 100);
  // Desktop parity: 1920x720 -> 1920x900 resize scales 120,100 to 150,125.
  v.rescaleOffset(150 / 120, 125 / 100);
  assert.deepEqual([v.offsetX, v.offsetY], [150, 125]);
  v.rescaleOffset(0, NaN); // ignored
  assert.deepEqual([v.offsetX, v.offsetY], [150, 125]);
});

test('split position is unclamped during drag and clamped on release', () => {
  const v = new Viewport();
  v.setSplitPos(1.2);
  assert.equal(v.splitPos, 1.2);
  v.setSplitPos(-0.3);
  assert.equal(v.splitPos, -0.3);
  v.setSplitPos(-0.3, true);
  assert.equal(v.splitPos, 0);
  v.setSplitPos(1.2, true);
  assert.equal(v.splitPos, 1);
  v.setSplitPos(NaN);
  assert.equal(v.splitPos, 1);
});

test('apply validates patches for the automation surface', () => {
  const v = new Viewport();
  v.apply({ mode: 'split', splitPos: 0.72, zoom: 4, offsetX: 10, offsetY: -5, pixelSize: 'fill', channel: 'y' });
  assert.deepEqual(v.snapshot(), { arrangement: 'horizontal', mode: 'split', splitPos: 0.72, zoom: 4, offsetX: 10, offsetY: -5, pixelSize: 'fill', channel: 'y' });
  v.apply({ arrangement: 'grid' });
  assert.equal(v.snapshot().arrangement, 'grid');
  assert.throws(() => v.apply({ arrangement: 'invalid' as never }));
  v.apply({ splitPos: 7 }); // clamped
  assert.equal(v.splitPos, 1);
  v.apply({ zoom: 999 });
  assert.equal(v.zoom, ZOOM_MAX);
  assert.throws(() => v.apply({ mode: 'stack' as never }));
  assert.throws(() => v.apply({ pixelSize: 'auto' as never }));
  assert.throws(() => v.apply({ channel: 'alpha' as never }));
  assert.throws(() => v.apply({ offsetX: Infinity }));
});

test('pixel pans retain their intent through acceleration and reversals; explicit zoom and fresh mouse notches still work', () => {
  const gesture = new WheelGesture();
  const sample = (deltaX: number, deltaY: number, timeStamp: number, deltaMode = 0, ctrlKey = false, momentum?: boolean) =>
    gesture.classify({ deltaX, deltaY, timeStamp, deltaMode, ctrlKey, momentum });
  assert.equal(sample(3, -5, 0), 'pan');
  assert.equal(sample(1, -78, 8), 'pan');
  assert.equal(sample(0, 90, 16), 'pan');
  assert.equal(sample(0, 120, 400), 'zoom');
  assert.equal(sample(0, -100, 700), 'zoom');
  assert.equal(sample(0, 90.90908893868948, 920), 'zoom');
  assert.equal(sample(10, 90, 1200), 'pan');
  assert.equal(sample(0, 3, 1208, 0, true), 'zoom');
  assert.equal(sample(0, -1, 1216, 1), 'zoom');
  assert.equal(sample(0, 1, 1224, 2), 'zoom');
  assert.equal(sample(1, 0, 1232, 1), 'pan');
});

test('decelerating direct input and the native inertia tail both pan', () => {
  const gesture = new WheelGesture();
  for (let i = 0; i < 30; i++) {
    const event = { deltaX: -24 * .95 ** i, deltaY: 60 * .95 ** i, deltaMode: 0, ctrlKey: false, timeStamp: i * 8 };
    assert.equal(gesture.classify(event), 'pan');
    assert.equal(gesture.classify({ ...event, momentum: false }), 'pan');
  }
  assert.equal(gesture.classify({ deltaX: 0, deltaY: 75, deltaMode: 0, ctrlKey: false, timeStamp: 256, momentum: true }), 'pan');
  assert.equal(gesture.classify({ deltaX: 0, deltaY: -80, deltaMode: 0, ctrlKey: false, timeStamp: 264 }), 'pan');
});

test('forced modes keep pinch zoom and native momentum continues the preceding axis', () => {
  const gesture = new WheelGesture();
  const event = { deltaX: 0, deltaY: 120, deltaMode: 1, timeStamp: 0, ctrlKey: false };
  assert.equal(gesture.classify(event, 'pan'), 'pan');
  for (const mode of ['auto', 'pan', 'vertical-zoom'] as const) assert.equal(gesture.classify({ ...event, ctrlKey: true }, mode), 'zoom');
  assert.equal(gesture.classify(event, 'vertical-zoom'), 'zoom');
  assert.equal(gesture.classify({ ...event, deltaX: 20, deltaY: 1 }, 'vertical-zoom'), 'pan');
  assert.equal(gesture.classify({ ...event, timeStamp: 12, momentum: true }, 'vertical-zoom'), 'pan');
});

test('wheel delta normalization covers line and page modes', () => {
  assert.equal(normalizeWheelDelta(3, 0), 3);
  assert.equal(normalizeWheelDelta(3, 1), 120);
  assert.equal(normalizeWheelDelta(1, 2), 800);
});

test('choosing 1x recenters even when already at 1x after panning', () => {
  const view = new Viewport(); view.panBy(1000, -500);
  assert.equal(view.setZoom(1), true);
  assert.equal(view.offsetX, 0); assert.equal(view.offsetY, 0); assert.equal(view.zoom, 1);
});

test('zooming out at 1x recenters for wheel and pinch without changing magnification', () => {
  for (const factor of [wheelZoomFactor(120, 0, false), wheelZoomFactor(8.5, 0, true), .95]) {
    const view = new Viewport(); view.panBy(1000, -500);
    assert.equal(view.zoomAt(factor, 300, -160), true);
    assert.deepEqual([view.zoom, view.offsetX, view.offsetY], [1, 0, 0]);
    assert.equal(view.zoomAt(factor, 300, -160), false, 'already centered is unchanged');
  }
});

test('neutral and invalid zoom input at 1x preserve pan', () => {
  const view = new Viewport(); view.panBy(1000, -500);
  for (const factor of [1, wheelZoomFactor(NaN, 0, true), 0, -1, Infinity]) {
    assert.equal(view.zoomAt(factor), false);
    assert.deepEqual([view.zoom, view.offsetX, view.offsetY], [1, 1000, -500]);
  }
});


test('pinch recovers browser scale independent of event coalescing and keeps its anchor', () => {
  const delta = -100 * Math.log(2);
  assert.ok(Math.abs(wheelZoomFactor(delta, 0, true) - 2) < 1e-12);
  const v = new Viewport();
  for (let i = 0; i < 20; i++) v.zoomAt(wheelZoomFactor(delta / 20, 0, true), 100, 60);
  assert.ok(Math.abs(v.zoom - 2) < 1e-12);
  assert.ok(Math.abs((100 - v.offsetX) / v.zoom - 100) < 1e-12);
  assert.ok(Math.abs((60 - v.offsetY) / v.zoom - 60) < 1e-12);
  v.zoomAt(wheelZoomFactor(-delta, 0, true), 100, 60);
  assert.ok(Math.abs(v.zoom - 1) < 1e-12);
});

test('ordinary wheel preserves notch speed and malformed deltas cannot poison zoom', () => {
  assert.ok(Math.abs(wheelZoomFactor(-120, 0, false) - 1.1) < 1e-12);
  assert.ok(Math.abs(wheelZoomFactor(-3, 1, true) - 1.1) < 1e-12);
  assert.equal(wheelZoomFactor(NaN, 0, true), 1);
  assert.equal(wheelZoomFactor(Infinity, 0, true), 1);
  assert.ok(Number.isFinite(wheelZoomFactor(-1e300, 0, true)));
});


test('wipe seam and opaque stroke share physical pixel boundaries at fractional panel origins',async()=>{
  const {splitPixelGeometry}=await import('../../shared/presentation/viewport.ts');
  for(const dpr of [1,1.25,1.5,2,3]) for(const left of [0,.25,160.375]) for(const fraction of [-.1,0,.333,.501,1,1.1]) {
    const result=splitPixelGeometry(fraction,749.5,left,dpr);
    const physical=(left+result.x)*dpr;
    assert.ok(Math.abs(physical-Math.round(physical))<1e-9);
    assert.ok(Math.abs(result.x-fraction*749.5)<=.5/dpr+1e-9);
    assert.ok(Math.abs((left+result.x-result.strokeWidth/2)*dpr-Math.round(physical-1))<1e-9);
  }
});


test('fit reserves header/transport bands and centers tall video between unequal overlays', () => {
  const area = unobscuredFitArea(800, 600, [
    { left: 0, right: 800, top: 0, bottom: 40 },
    { left: 0, right: 800, top: 520, bottom: 590 },
  ]);
  assert.equal(area.height, 472); assert.equal(area.centerY, -20);
  const fit = fitContain(area.width, area.height, 720, 1280);
  const top = 300 + area.centerY - fit.height / 2;
  assert.ok(top >= 44); assert.ok(top + fit.height <= 516);
});

test('only physically intersecting chrome reserves space in grid and split cells', () => {
  const upper = unobscuredFitArea(500, 300, [
    { left: 0, right: 500, top: 0, bottom: 40 },
    { left: 0, right: 1000, top: 510, bottom: 580 },
    { left: 500, right: 1000, top: 0, bottom: 40 },
  ]);
  assert.equal(upper.height, 256); assert.equal(upper.centerY, 22);
  const lower = unobscuredFitArea(500, 300, [
    { left: 0, right: 500, top: 260, bottom: 300 },
    { left: 0, right: 1000, top: 190, bottom: 250 },
  ]);
  assert.equal(lower.height, 186); assert.equal(lower.centerY, -57);
});

test('uniform fit respects every safe area for mixed portrait and landscape video', () => {
  const tracks = [
    { slotW: 800, slotH: 472, videoW: 3840, videoH: 2160 },
    { slotW: 800, slotH: 386, videoW: 1080, videoH: 1920 },
  ];
  const reference = fitReference(tracks);
  const sizes = tracks.map(track => fittedSize(track, reference, 'uniform'));
  sizes.forEach((size, i) => { assert.ok(size.width <= tracks[i].slotW + 1e-8); assert.ok(size.height <= tracks[i].slotH + 1e-8); });
  assert.ok(Math.abs(sizes[0].width / tracks[0].videoW - sizes[1].width / tracks[1].videoW) < 1e-8);
});
