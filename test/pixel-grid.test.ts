import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelGrid } from '../src/ui/pixel-grid-model.ts';
const view = { width: 960, height: 720, imageWidth: 960, imageHeight: 540, sourceWidth: 1920, sourceHeight: 1080, zoom: 1, panX: 0, panY: 0 };

test('all resolutions use fixed square 320 source-pixel cells and literal dimensions', () => {
  for (const [width, height] of [[320, 180], [1280, 720], [1920, 1080], [3840, 2160], [7680, 4320]]) {
    const g = pixelGrid({ ...view, sourceWidth: width, sourceHeight: height })!;
    assert.equal(g.label, `${width}×${height}`);
    assert.equal(g.cellWidth, 320); assert.equal(g.cellHeight, 320);
    assert.equal(g.spacingX, g.spacingY);
  }
});
test('zoom and small viewports preserve the same cell meaning without merging', () => {
  const normal = pixelGrid(view)!;
  const zoomed = pixelGrid({ ...view, zoom: 2 })!;
  assert.equal(zoomed.cellWidth, 320); assert.equal(zoomed.spacingX, normal.spacingX * 2);
  const tiny = pixelGrid({ ...view, imageWidth: 240, imageHeight: 135, sourceWidth: 3840, sourceHeight: 2160 })!;
  assert.equal(tiny.cellWidth, 320); assert.equal(tiny.spacingX, 20);
  assert.equal(tiny.label, '3840×2160');
});
test('pan follows the source origin and wraps negative offsets without changing scale', () => {
  const before = pixelGrid(view)!;
  const after = pixelGrid({ ...view, panX: -20, panY: 30 })!;
  assert.equal(after.startX, before.spacingX - 20);
  assert.equal(after.startY, (before.startY + 30) % before.spacingY);
  assert.equal(after.cellWidth, before.cellWidth);
  assert.deepEqual(pixelGrid({ ...view, panX: before.spacingX, panY: -before.spacingY }), before);
});
test('uniform pixel density produces the same grid for differently sized sources', () => {
  const a = pixelGrid(view)!;
  const b = pixelGrid({ ...view, imageWidth: 480, imageHeight: 270, sourceWidth: 960, sourceHeight: 540 })!;
  assert.equal(a.spacingX, b.spacingX); assert.equal(a.spacingY, b.spacingY);
  assert.equal(b.label, '960×540');
});
test('invalid and hidden geometry produces no grid', () => {
  assert.equal(pixelGrid({ ...view, width: 0 }), null);
  assert.equal(pixelGrid({ ...view, sourceWidth: 0 }), null);
  assert.equal(pixelGrid({ ...view, zoom: NaN }), null);
});
