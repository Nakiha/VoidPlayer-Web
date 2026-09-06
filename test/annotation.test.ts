import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawingsValue } from '../src/annotation.ts';

test('annotation geometry is bounded and copied before entering the session', () => {
  const source = [{ tool: 'pen', points: [{ x: 0, y: 1 }, { x: .5, y: .5 }] }, { tool: 'text', points: [{ x: .1, y: .2 }], text: '边缘' }];
  const result = drawingsValue(source);
  source[0].points[0].x = 1;
  assert.equal(result[0].points[0].x, 0);
  assert.equal(result[1].text, '边缘');
  for (const bad of [NaN, Infinity, -1, 1.01, '0']) assert.throws(() => drawingsValue([{ tool: 'pen', points: [{ x: bad, y: 0 }] }]));
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
