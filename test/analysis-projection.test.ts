import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAxisIndex, decideLayout, matchPairsStrict, panTimeRange, projectToSession, zoomTimeRange } from '../src/analysis/projection.ts';
import type { AnalysisSample } from '../src/analysis/types.ts';

const sample = (id: string, ordinal: number, pts: number | null, dts: number | null = pts): AnalysisSample => ({
  sampleId: id, decodeOrdinal: ordinal, containerPtsUs: pts, effectivePtsUs: pts, dtsUs: dts,
  sizeBytes: 1000, randomAccess: 'unknown', pictureType: null, pictureTypeSource: 'unavailable', qp: null,
});

test('会话投影：normalizedMediaUs + offsetUs，正偏移延后', () => {
  assert.equal(projectToSession(1000, 500), 1500);
  assert.equal(projectToSession(1000, -1500), -500);
});

test('轴索引不重排原数组，重复 PTS 用序号 tie-break 且不丢弃', () => {
  const samples = [sample('a', 1, 2000), sample('b', 0, 2000), sample('c', 2, 1000)];
  const { order, times } = buildAxisIndex(samples, 'pts', 0);
  assert.deepEqual(order, [2, 1, 0]);
  assert.deepEqual([...times], [1000, 2000, 2000]);
  assert.deepEqual(samples.map(s => s.sampleId), ['a', 'b', 'c']);
});

test('缺失 DTS 的样本不进入 DTS 索引，不伪造', () => {
  const samples = [sample('a', 0, 1000, null), sample('b', 1, 2000, 500)];
  const { order } = buildAxisIndex(samples, 'dts', 0);
  assert.deepEqual(order, [1]);
});

test('严格配对：容差内一一对应，报出时间差', () => {
  const { pairs, unmatchedA, unmatchedB } = matchPairsStrict(
    new Float64Array([0, 33_333, 66_666]), new Float64Array([100, 33_400, 66_700]), 1000);
  assert.equal(pairs.length, 3);
  assert.deepEqual(unmatchedA, []);
  assert.deepEqual(unmatchedB, []);
  assert.ok(Math.abs(pairs[0].dtUs - 100) < 1e-9);
});

test('帧率不同时不硬配对：60fps 配 30fps 留下未匹配', () => {
  const a = new Float64Array([0, 33_333, 66_666]);
  const b = new Float64Array([0, 16_666, 33_333, 50_000, 66_666]);
  const { pairs, unmatchedB } = matchPairsStrict(a, b, 1000);
  assert.equal(pairs.length, 3);
  assert.equal(unmatchedB.length, 2);
});

test('每个样本最多用一次，不重复计数', () => {
  const { pairs } = matchPairsStrict(new Float64Array([0, 500]), new Float64Array([100]), 1000);
  assert.equal(pairs.length, 1);
});

test('布局决策：双轨高覆盖才并排，否则分行；三轨分行', () => {
  assert.equal(decideLayout({ trackCount: 2, pairCoverage: 0.99, maxAbsDtUs: 100, toleranceUs: 1000 }), 'paired');
  assert.equal(decideLayout({ trackCount: 2, pairCoverage: 0.5, toleranceUs: 1000 }), 'rows');
  assert.equal(decideLayout({ trackCount: 3, pairCoverage: 1, toleranceUs: 1000 }), 'rows');
});

test('缩放以 hover 点为锚点，钳制在区间内', () => {
  const domain = { start: 0, end: 10_000_000 };
  // 中心放大一倍：中心不动，两边各收一半。
  assert.deepEqual(zoomTimeRange(0, 10_000_000, 5_000_000, 0.5, 10_000, domain), { start: 2_500_000, end: 7_500_000 });
  // 左边缘为锚点放大：左端不动。
  assert.deepEqual(zoomTimeRange(0, 10_000_000, 0, 0.5, 10_000, domain), { start: 0, end: 5_000_000 });
  // 缩小到底钳制到最小跨度。
  assert.deepEqual(zoomTimeRange(0, 20_000, 10_000, 0.1, 10_000, domain), { start: 5_000, end: 15_000 });
  // 放大出界钳制到 domain。
  assert.deepEqual(zoomTimeRange(8_000_000, 10_000_000, 9_000_000, 4, 10_000, domain), { start: 2_000_000, end: 10_000_000 });
});

test('平移钳制在两端，不丢区间宽度', () => {
  const domain = { start: 0, end: 10_000_000 };
  assert.deepEqual(panTimeRange(0, 2_000_000, 3_000_000, domain), { start: 3_000_000, end: 5_000_000 });
  assert.deepEqual(panTimeRange(0, 2_000_000, -5_000_000, domain), { start: 0, end: 2_000_000 });
  assert.deepEqual(panTimeRange(8_000_000, 10_000_000, 5_000_000, domain), { start: 8_000_000, end: 10_000_000 });
});
