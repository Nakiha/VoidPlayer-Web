import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitrateAtT, buildInspection, coarsenBucketsShared, estimateBaseBucketWidth,
  getDerived, localRateAtT, referenceAtT,
} from '../src/analysis/inspection.ts';
import type { AnalysisResult } from '../src/analysis/types.ts';
import type { Slot } from '../src/model.ts';

function makeResult(samples: { t: number; size: number }[], bitrate: { t: number; mbps: number | null }[] = [], coverage = { start: 0, end: 2_000_000 }): AnalysisResult {
  return {
    requestId: 1, sourceVersion: 'm@10', indexRevision: 10, axis: 'pts',
    origin: { firstPtsUs: 0, offsetUs: 0 },
    samples: samples.map((s, i) => ({
      sampleId: `m:v:${i}`, decodeOrdinal: i,
      containerPtsUs: s.t, effectivePtsUs: s.t, dtsUs: s.t,
      sizeBytes: s.size, randomAccess: 'no' as const,
      pictureType: null, pictureTypeSource: 'unavailable' as const, qp: null,
    })),
    truncated: false,
    buckets: null,
    bitrate: bitrate.map(b => ({ tUs: b.t, mbps: b.mbps, shortWindow: false, provisional: false })),
    capability: {
      hasSize: true, hasDts: true, keySource: 'container',
      pictureType: 'key-only', qp: 'unsupported', indexState: 'complete',
    },
    coverageUs: coverage,
  };
}

test('相同样本数的新范围不复用旧轴数组：WeakMap 按快照身份隔离', () => {
  const oldR = makeResult([{ t: 0, size: 10 }, { t: 100_000, size: 10 }, { t: 200_000, size: 10 }]);
  const newR = makeResult([{ t: 1_000_000, size: 10 }, { t: 1_100_000, size: 10 }, { t: 1_200_000, size: 10 }]);
  const dOld = getDerived(oldR, 'pts')!;
  const dNew = getDerived(newR, 'pts')!;
  assert.notEqual(dOld.times[0], dNew.times[0]);
  // 新范围 1005ms 应参考 1000ms 样本，而不是旧数组的 1200ms。
  const { ref } = referenceAtT(newR, 'pts', 1_005_000, 'known');
  assert.ok(ref);
  assert.equal(ref.axisUs, 1_000_000);
});

test('视口只返回局部样本时不得报告不同的"确定" 1s 局部帧率（F1 回归）', () => {
  // 同一合成 VFR 片源：前 1s 30fps，后 1s 60fps；T=1.1s，算法窗口固定 1s。
  const times = [
    ...Array.from({ length: 30 }, (_, i) => Math.round(i * 1e6 / 30)),
    ...Array.from({ length: 60 }, (_, i) => 1e6 + Math.round(i * 1e6 / 60)),
  ];
  const full = makeResult(times.map(t => ({ t, size: 1000 })));
  const fullRate = localRateAtT(full, 'pts', 1_100_000, 'known');
  assert.ok(fullRate.value != null && !fullRate.provisional && !fullRate.shortWindow);
  // 深度放大后查询只返回 [1.050s, 1.150s) 的样本：同一 T 的统计口径不得改变，
  // 覆盖不了完整统计窗口时必须标记（shortWindow/provisional）或拒绝给值。
  const clipped: AnalysisResult = {
    ...full,
    samples: full.samples.filter(s => s.effectivePtsUs! >= 1_050_000 && s.effectivePtsUs! < 1_150_000),
  };
  const partial = localRateAtT(clipped, 'pts', 1_100_000, 'known');
  const transparent = partial.value == null || partial.provisional || partial.shortWindow;
  assert.ok(
    transparent || Math.abs(partial.value! - fullRate.value!) < 0.01,
    `full=${fullRate.value}, partial=${partial.value}, provisional=${partial.provisional}, short=${partial.shortWindow}`,
  );
});

test('稀疏非空桶按公共粗网格合并：A[0,20)/[20,40) B 不错位', () => {  // 基础桶宽 10ms，A 非空下标 0/1/2/3，B 非空 0/2/4/6。
  const mk = (idx: number) => ({
    startUs: idx * 10_000, endUs: (idx + 1) * 10_000, count: 1,
    maxBytes: 1000, sumBytes: 1000, keyCount: 0, deltaCount: 1, unknownCount: 0,
    complete: true, maxSampleId: `s${idx}`,
  });
  const a = [0, 1, 2, 3].map(mk);
  const b = [0, 2, 4, 6].map(mk);
  const coarse = 20_000;
  const ca = coarsenBucketsShared(a, 10_000, coarse, 0);
  const cb = coarsenBucketsShared(b, 10_000, coarse, 0);
  assert.deepEqual(ca.map(x => [x.startUs, x.endUs]), [[0, 20_000], [20_000, 40_000]]);
  // B 的 [0,30) 错误合并不得出现；公共网格下为 [0,20)/[20,30)→[20,40)/[40,60)→[40,60)/[60,80)。
  assert.deepEqual(cb.map(x => [x.startUs, x.endUs]), [[0, 20_000], [20_000, 40_000], [40_000, 60_000], [60_000, 80_000]]);
  // 每个样本只计一次。
  assert.equal(cb.reduce((n, x) => n + x.count, 0), 4);
});

test('空桶不推断无覆盖：两帧之间仍可读码率', () => {
  const r = makeResult(
    [{ t: 0, size: 100_000 }, { t: 500_000, size: 100_000 }],
    [{ t: 250_000, mbps: 3.2 }],
  );
  // T=250ms 处没有新样本起始，但码率窗口有值。
  const b = bitrateAtT(r, 250_000, 250_000, 10_000, 'known');
  assert.equal(b.value, 3.2);
  const { ref, empty } = referenceAtT(r, 'pts', 250_000, 'known');
  // 两帧之间：参考帧标 nearby，不把空桶称为未覆盖。
  assert.ok(ref);
  assert.equal(ref.relation, 'nearby');
  assert.equal(empty, false);
  // 远离所有样本处：无参考但覆盖已知，标“无新样本”而非未知。
  const far = referenceAtT(r, 'pts', 1_800_000, 'known');
  assert.equal(far.ref, null);
  assert.equal(far.empty, true);
});

test('局部帧率口径：30fps 用间隔估计，不用 count/窗长', () => {
  // 30fps 1s 内 30 帧，间隔 33333us。
  const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 33_333, size: 50_000 }));
  const r = makeResult(samples);
  const m = localRateAtT(r, 'pts', 500_000, 'known');
  assert.ok(m.value != null && Math.abs(m.value - 30) < 0.6, `fps=${m.value}`);
  assert.equal(m.kind, 'display-fps');
  // 250ms 窗内容纳 7 或 8 个事件时，不得用 28/32 冒充稳定帧率：本估计仍 ~30。
  const m2 = localRateAtT(r, 'pts', 125_000, 'known');
  assert.ok(m2.value != null && Math.abs(m2.value - 30) < 0.6, `fps=${m2.value}`);
});

test('VFR/重复PTS/跳变不伪造帧率', () => {
  const dup = makeResult([{ t: 0, size: 10 }, { t: 0, size: 10 }]);
  assert.equal(localRateAtT(dup, 'pts', 0, 'known').value, null);
  const jump = makeResult([
    { t: 0, size: 10 }, { t: 33_333, size: 10 }, { t: 900_000, size: 10 },
  ]);
  assert.equal(localRateAtT(jump, 'pts', 450_000, 'known').value, null);
  const single = makeResult([{ t: 0, size: 10 }]);
  assert.equal(localRateAtT(single, 'pts', 0, 'known').value, null);
});

test('DTS 模式返回解码样本率，不冒充展示 FPS', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 40_000, size: 1000 }));
  const r = makeResult(samples);
  const m = localRateAtT(r, 'dts', 200_000, 'known');
  assert.equal(m.kind, 'sample-rate');
  assert.equal(m.unit, '样本/秒');
});

test('同一 x 上下移动指标一致：buildInspection 只依赖 T', () => {
  const mkRes = (dt: number) => makeResult(
    [{ t: 900_000 + dt, size: 155_581 }, { t: 933_333 + dt, size: 150_000 }],
    [{ t: 917_000, mbps: 33.9 }],
  );
  const results = new Map<Slot, AnalysisResult>([['A' as Slot, mkRes(13_000)], ['B' as Slot, mkRes(0)]]);
  const caps = new Map([
    ['A' as Slot, mkRes(0).capability], ['B' as Slot, mkRes(0).capability],
  ]);
  const a = buildInspection({
    axis: 'pts', inspectionTimeUs: 917_000, windowUs: 250_000, stepUs: 5000,
    order: ['A' as Slot, 'B' as Slot], results, caps, domain: { start: 0, end: 10_000_000 },
    directTarget: null,
  });
  const b = buildInspection({
    axis: 'pts', inspectionTimeUs: 917_000, windowUs: 250_000, stepUs: 5000,
    order: ['A' as Slot, 'B' as Slot], results, caps, domain: { start: 0, end: 10_000_000 },
    directTarget: { kind: 'sample', slot: 'A' as Slot, sampleId: 'm:v:0' },
  });
  // 直接目标变化不改变公共时间指标。
  assert.deepEqual(a.tracks.map(t => t.bitrate.value), b.tracks.map(t => t.bitrate.value));
  assert.equal(a.inspectionTimeUs, b.inspectionTimeUs);
  // 两轨同一份字段：码率都有值，不依赖大小 glyph。
  assert.equal(a.tracks[0].bitrate.value, 33.9);
  assert.equal(a.tracks[1].bitrate.value, 33.9);
});

test('远距离码率点不延伸：缺失区间不断言', () => {
  const r = makeResult([{ t: 0, size: 10 }], [{ t: 0, mbps: 5 }]);
  const far = bitrateAtT(r, 900_000, 250_000, 5_000, 'known');
  assert.equal(far.value, null);
  assert.equal(far.approximate, true);
});

test('短轨在长会话域后半段显示已结束，而非空值 known', () => {
  const short = makeResult([{ t: 0, size: 10 }], [{ t: 0, mbps: 5 }], { start: 0, end: 4_000_000 });
  const { ref } = referenceAtT(short, 'pts', 5_000_000, 'outside');
  assert.equal(ref, null);
  const insp = buildInspection({
    axis: 'pts', inspectionTimeUs: 5_000_000, windowUs: 250_000, stepUs: 5000,
    order: ['A' as Slot], results: new Map([['A' as Slot, short]]),
    caps: new Map([['A' as Slot, short.capability]]),
    domain: { start: 0, end: 10_000_000 }, directTarget: null,
  });
  assert.equal(insp.tracks[0].coverageState, 'outside');
  assert.equal(insp.tracks[0].bitrate.value, null);
});

test('estimateBaseBucketWidth 含空桶仍稳定', () => {
  const buckets = [0, 1, 2, 3].map(i => ({ startUs: i * 10_000, endUs: (i + 1) * 10_000 }));
  assert.equal(estimateBaseBucketWidth(buckets), 10_000);
});
