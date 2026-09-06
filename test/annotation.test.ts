import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawingsValue, drawingStrokeWidth } from '../src/annotation.ts';

test('annotation workspace geometry is finite and copied before entering the session', () => {
  const source = [{ tool: 'pen', points: [{ x: 0, y: 1 }, { x: .5, y: .5 }] }, { tool: 'text', points: [{ x: .1, y: .2 }], text: '边缘' }];
  const result = drawingsValue(source);
  source[0].points[0].x = 1;
  assert.equal(result[0].points[0].x, 0);
  assert.equal(result[1].text, '边缘');
  for (const bad of [NaN, Infinity, -10001, 10001, '0']) assert.throws(() => drawingsValue([{ tool: 'pen', points: [{ x: bad, y: 0 }] }]));
  assert.throws(() => drawingsValue([{ tool: 'line', points: [{ x: 0, y: 0 }] }]));
  assert.throws(() => drawingsValue([{ tool: 'text', points: [{ x: 0, y: 0 }], text: ' ' }]));
  assert.throws(() => drawingsValue(Array(201).fill(source[0])));
  assert.throws(() => drawingsValue([{ tool: 'pen', points: Array(4001).fill({ x: 0, y: 0 }) }]));
});


test('multi-view drafts require every media identity and frame anchor to match', async () => {
  const { annotationAnchorsCurrent } = await import('../src/annotation.ts');
  const anchors = [{ slot:'A', mediaId:'first', ptsUs:100 }, { slot:'D', mediaId:'last', ptsUs:99 }];
  const tracks = [{slot:'A', id:'first', frame:{ptsUs:100}}, {slot:'D', id:'last', frame:{ptsUs:99}}];
  assert.equal(annotationAnchorsCurrent(anchors, tracks), true);
  assert.equal(annotationAnchorsCurrent(anchors, [...tracks].reverse()), true);
  assert.equal(annotationAnchorsCurrent(anchors, [tracks[0], {...tracks[1], frame:{ptsUs:100}}]), false);
  assert.equal(annotationAnchorsCurrent(anchors, [tracks[0], {...tracks[1], id:'replacement'}]), false);
  assert.equal(annotationAnchorsCurrent(anchors, [tracks[0]]), false);
});

test('object movement/resizing extends beyond the video and erasing splits vector ink', async () => {
  const { moveDrawing, resizeDrawing, eraseAt } = await import('../src/annotation-geometry.ts');
  const pen = { tool: 'pen' as const, id: 'stroke', color: '#112233', width: .004, strokeWidth: 4, points: [{ x: .1, y: .5 }, { x: .9, y: .5 }] };
  const moved = moveDrawing(pen, .9, -.9);
  assert.deepEqual(moved.points, [{ x: 1, y: -.4 }, { x: 1.8, y: -.4 }]);
  assert.equal(moved.strokeWidth, 4);
  assert.deepEqual(drawingsValue([moved])[0], moved);
  const pieces = eraseAt([pen], { x: .5, y: .5 }, 10, 100, 100);
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[0].points.at(-1)!.x - .4) < 1e-8);
  assert.ok(Math.abs(pieces[1].points[0].x - .6) < 1e-8);
  assert.equal(pieces[0].color, '#112233');
  assert.notEqual(pieces[0].id, pieces[1].id);
  const rect = resizeDrawing({ tool: 'rect', points: [{ x: .2, y: .2 }, { x: .4, y: .4 }] }, { x: -.1, y: -.1, width: 1.6, height: 1.6 });
  assert.ok(Math.abs(rect.points[1].x - 1.5) < 1e-8);
  assert.deepEqual(drawingsValue([pen])[0], pen);
  assert.throws(() => drawingsValue([{ ...pen, width: Infinity }]));
  assert.throws(() => drawingsValue([{ ...pen, color: 'url(example)' }]));
});

test('sampling threshold uses actual source-to-device pixel scale', async () => {
  const { presentationSampling } = await import('../src/presentation-surface.ts');
  const geometry = { width: 1000, height: 600, imageWidth: 500, imageHeight: 300, zoom: 2, offsetX: 0, offsetY: 0, dpr: 1 };
  assert.equal(presentationSampling(1920, geometry), 'bilinear');
  assert.equal(presentationSampling(1920, { ...geometry, dpr: 2 }), 'nearest');
});

test('stroke widths are CSS pixels and legacy widths have a stable fallback', () => {
  const rect = { tool: 'rect' as const, points: [{ x: -.1, y: .1 }, { x: 1.1, y: 1.2 }] };
  for (const width of [.001, .01, .1]) assert.equal(drawingStrokeWidth({ ...rect, width }), 4);
  for (const strokeWidth of [2, 4, 8]) assert.equal(drawingStrokeWidth(drawingsValue([{ ...rect, strokeWidth }])[0]), strokeWidth);
  for (const strokeWidth of [0, -1, 65, Infinity, '4']) assert.throws(() => drawingsValue([{ ...rect, strokeWidth }]));
});
