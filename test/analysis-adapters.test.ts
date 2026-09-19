import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceQuerier, runSourceQuery, locateSampleById } from '../src/analysis/adapters.ts';
import { coverageFor } from '../src/analysis/inspection.ts';
import type { SourceQueryContext } from '../src/analysis/adapters.ts';

const ctx: SourceQueryContext = {
  mediaId: 'm1',
  firstPtsUs: 0,
  durationUs: 1_000_000,
  sourceVersion: 'v1',
  indexRevision: 10,
  capability: {
    hasSize: true, hasDts: true, keySource: 'container',
    pictureType: 'key-only', qp: 'unsupported', indexState: 'complete',
  },
  coverageUs: { start: 0, end: 1_000_000 },
};

const packets = Array.from({ length: 10 }, (_, i) => ({
  pts: i * 100_000, dts: i * 100_000, size: 100 * 1024, key: i === 0,
}));

test('小范围返回逐样本，大码率窗给出 Mbps', () => {
  const r = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'pts', startUs: 0, endUs: 1_000_000, pixelWidth: 101, bitrateWindowUs: 1_000_000,
  });
  assert.equal(r.truncated, false);
  assert.equal(r.samples.length, 10);
  assert.equal(r.samples[0].sampleId, 'm1:v:0');
  assert.equal(r.samples[0].randomAccess, 'yes');
  assert.equal(r.samples[1].randomAccess, 'no');
  assert.equal(r.samples[0].qp, null);
  assert.ok(r.bitrate && r.bitrate.length > 0);
  // t=500000 的 1s 窗恰为完整媒体区间，含全部 10 帧：10×100KiB×8/1s = 8.192Mbps。
  const center = r.bitrate.reduce((a, b) => Math.abs(b.tUs - 500_000) < Math.abs(a.tUs - 500_000) ? b : a);
  assert.equal(center.shortWindow, false);
  assert.ok(center.mbps !== null && Math.abs(center.mbps - 8.192) < 0.35, `center=${center.mbps}@${center.tUs}`);
  assert.ok(r.buckets && r.buckets.length > 0);
  assert.equal(r.buckets.reduce((n, b) => n + b.count, 0), 10);
});

test('超 maxSamples 截断样本但保留桶与码率', () => {
  const r = runSourceQuery(packets, ctx, {
    requestId: 2, axis: 'pts', startUs: 0, endUs: 1_000_000, pixelWidth: 10, bitrateWindowUs: 1_000_000, maxSamples: 5,
  });
  assert.equal(r.truncated, true);
  assert.equal(r.samples.length, 0);
  assert.ok(r.buckets && r.buckets.length > 0);
});

test('无 DTS 后端查 DTS 直接报错，不伪造', () => {
  const noDts: SourceQueryContext = {
    ...ctx, capability: { ...ctx.capability, hasDts: false },
  };
  assert.throws(() => runSourceQuery(packets, noDts, {
    requestId: 3, axis: 'dts', startUs: 0, endUs: 1000, pixelWidth: 10, bitrateWindowUs: 1_000_000,
  }), /DTS/);
});

test('B 帧重排：DTS 轴与 PTS 轴顺序不同，但样本身份一致', () => {
  const reorder = [
    { pts: 0, dts: 0, size: 50_000, key: true }, // I0
    { pts: 120_000, dts: 40_000, size: 40_000, key: true }, // P3（解码在前）
    { pts: 40_000, dts: 80_000, size: 5_000, key: false }, // B1
    { pts: 80_000, dts: 120_000, size: 5_000, key: false }, // B2
  ];
  const ptsView = runSourceQuery(reorder, ctx, {
    requestId: 4, axis: 'pts', startUs: 0, endUs: 200_000, pixelWidth: 50, bitrateWindowUs: 500_000,
  });
  const dtsView = runSourceQuery(reorder, ctx, {
    requestId: 5, axis: 'dts', startUs: 0, endUs: 200_000, pixelWidth: 50, bitrateWindowUs: 500_000,
  });
  assert.deepEqual(ptsView.samples.map(s => s.sampleId), ['m1:v:0', 'm1:v:2', 'm1:v:3', 'm1:v:1']);
  assert.deepEqual(dtsView.samples.map(s => s.sampleId), ['m1:v:0', 'm1:v:1', 'm1:v:2', 'm1:v:3']);
});

test('DTS 轴导出的覆盖与内部计算一致：负 DTS 不被判 outside（F7 回归）', () => {
  const dtsCtx: SourceQueryContext = {
    ...ctx, durationUs: 200_000, coverageUs: { start: 0, end: 200_000 },
  };
  const negDts = [0, 1, 2].map(i => ({ pts: i * 40_000, dts: -80_000 + i * 40_000, size: 10_000, key: i === 0 }));
  const r = runSourceQuery(negDts, dtsCtx, {
    requestId: 6, axis: 'dts', startUs: -80_000, endUs: 100_000, pixelWidth: 9, bitrateWindowUs: 250_000,
  });
  assert.ok(r.samples.some(s => s.dtsUs !== null && s.dtsUs < 0));
  assert.ok(r.bitrate && r.bitrate.some(p => p.tUs < 0 && p.mbps != null));
  // 内部按扩展覆盖计算了负 DTS 的码率，导出的覆盖也必须包含同一区间。
  assert.ok(r.coverageUs && r.coverageUs.start <= -80_000);
  assert.equal(coverageFor(r.capability, r, -50_000, { start: -80_000, end: 200_000 }), 'known');
});

test('桶峰值按身份有界定位：不依赖 raw 是否在视口查询里返回（F2）', () => {
  // 截断查询（超过 maxSamples）不返回 raw 样本，但桶仍带 maxSampleId。
  const r = runSourceQuery(packets, ctx, {
    requestId: 7, axis: 'pts', startUs: 0, endUs: 1_000_000, pixelWidth: 10, bitrateWindowUs: 1_000_000, maxSamples: 5,
  });
  assert.equal(r.truncated, true);
  const peak = r.buckets!.map(b => b.maxSampleId).find((id): id is string => id != null);
  assert.ok(peak);
  const located = locateSampleById(packets, ctx.mediaId, ctx.firstPtsUs, peak);
  assert.ok(located);
  // 与 raw 查询返回的同 id 样本字段一致（同一物化口径）。
  const raw = runSourceQuery(packets, ctx, {
    requestId: 8, axis: 'pts', startUs: 0, endUs: 1_000_000, pixelWidth: 10, bitrateWindowUs: 1_000_000,
  });
  assert.deepEqual(located, raw.samples.find(s => s.sampleId === peak));
  // 非本媒体/越界/伪造身份一律 null，不猜不崩。
  assert.equal(locateSampleById(packets, 'other', ctx.firstPtsUs, peak), null);
  assert.equal(locateSampleById(packets, ctx.mediaId, ctx.firstPtsUs, 'm1:v:999'), null);
  assert.equal(locateSampleById(packets, ctx.mediaId, ctx.firstPtsUs, 'm1:v:-1'), null);
  assert.equal(locateSampleById(packets, ctx.mediaId, ctx.firstPtsUs, 'garbage'), null);
});

test('曲线采样超出片长时尾部断开不断言尖峰（多轨片尾回归）', () => {
  // A 轨 2s 结束、B 轨更长时，A 的曲线查询区间会伸到片外；片外点必须为 null，
  // 片内最大值保持正常量级（不被残窗归一化抬成 2000Mbps 级尖峰）。
  const N = 60;
  const tail = Array.from({ length: N }, (_, i) => ({
    pts: Math.round((i * 1e6) / 30), dts: Math.round((i * 1e6) / 30),
    size: 2000, key: false,
  }));
  tail[N - 1] = { ...tail[N - 1], size: 300_000, key: true };
  const twoSec: SourceQueryContext = {
    ...ctx, durationUs: 2_000_000, coverageUs: { start: 0, end: 2_000_000 },
  };
  const r = runSourceQuery(tail, twoSec, {
    requestId: 9, axis: 'pts', startUs: 0, endUs: 2_000_000, pixelWidth: 100, bitrateWindowUs: 250_000,
    curveStartUs: 1_800_000, curveEndUs: 2_200_000, curvePixelWidth: 100,
  });
  assert.ok(r.bitrate && r.bitrate.length > 0);
  const outside = r.bitrate.filter(p => p.tUs >= 2_000_000);
  assert.ok(outside.length > 0, 'curve extends past duration');
  assert.ok(outside.every(p => p.mbps == null), `outside=${outside.map(p => `${p.tUs}:${p.mbps}`).join(',')}`);
  const inside = r.bitrate.filter(p => p.tUs < 2_000_000 && p.mbps != null).map(p => p.mbps as number);
  assert.ok(inside.length > 0);
  assert.ok(Math.max(...inside) < 100, `max inside=${Math.max(...inside)}`);
});

test('展示序排名：重排包表的 PTS 秩与二分一致，重复 PTS 共享 lowerBound', () => {
  // demux 序 0..5，PTS 含 B 帧重排：pos2 的 PTS 最小，pos0/pos1 同 PTS。
  const mixed = [
    { pts: 40000, dts: 0, size: 1000, key: true },
    { pts: 40000, dts: 40000, size: 1000, key: false },
    { pts: 0, dts: 80000, size: 1000, key: false },
    { pts: 120000, dts: 120000, size: 1000, key: false },
    { pts: 80000, dts: 160000, size: 1000, key: false },
    { pts: 160000, dts: 200000, size: 1000, key: false },
  ];
  const querier = createSourceQuerier();
  // PTS 排序后：0(pos2), 40000(pos0,pos1), 80000(pos4), 120000(pos3), 160000(pos5)
  assert.deepEqual(querier.rank(mixed, 0, 'pts', -1), { rank: 0, total: 6, ordinal: null });
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 0), { rank: 0, total: 6, ordinal: 2 });
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 40000), { rank: 1, total: 6, ordinal: 0 });
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 80000), { rank: 3, total: 6, ordinal: 4 });
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 160000), { rank: 5, total: 6, ordinal: 5 });
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 99999999), { rank: 6, total: 6, ordinal: null });
  // DTS 轴用各自时间同一规则
  assert.deepEqual(querier.rank(mixed, 0, 'dts', 80000), { rank: 2, total: 6, ordinal: 2 });
  // 排名与区间查询共用缓存：查完排名再查区间，结果不受影响
  const r = querier(mixed, ctx, {
    requestId: 10, axis: 'pts', startUs: 0, endUs: 200000, pixelWidth: 100, bitrateWindowUs: 1_000_000,
  });
  assert.equal(r.samples.length, 6);
  assert.deepEqual(querier.rank(mixed, 0, 'pts', 80000), { rank: 3, total: 6, ordinal: 4 });
  assert.throws(() => querier.rank(mixed, 0, 'pts' as never, NaN), /有限/);
});
