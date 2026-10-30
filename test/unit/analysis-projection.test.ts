import test from 'node:test';
import assert from 'node:assert/strict';
import { axisOf, panTimeRange, projectToSession, zoomTimeRange } from '../../shared/analysis/metadata/projection.ts';
import type { AnalysisSample } from '../../shared/analysis/metadata/types.ts';

const sample = (id: string, ordinal: number, pts: number | null, dts: number | null = pts): AnalysisSample => ({
  sampleId: id, decodeOrdinal: ordinal, containerPtsUs: pts, effectivePtsUs: pts, dtsUs: dts,
  sizeBytes: 1000, randomAccess: 'unknown', pictureType: null, pictureTypeSource: 'unavailable', qp: null,
});

test('会话投影：normalizedMediaUs + offsetUs，正偏移延后', () => {
  assert.equal(projectToSession(1000, 500), 1500);
  assert.equal(projectToSession(1000, -1500), -500);
});

test('当前轴投影保留缺失 DTS，不借 PTS 补造', () => {
  const value=sample('missing-dts',0,1000,null);
  assert.equal(axisOf(value,'pts'),1000);assert.equal(axisOf(value,'dts'),null);
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


test('overview zoom anchors to the displayed full-domain time after prior zoom', async () => {
  const { zoomOverviewRange } = await import('../../shared/analysis/metadata/projection.ts');
  const next = zoomOverviewRange({ start: 200, end: 400 }, { start: 0, end: 1000 }, 0.75, 0.5, 10);
  assert.deepEqual(next, { start: 700, end: 800 });
});
