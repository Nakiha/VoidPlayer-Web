import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceQuery } from '../src/analysis/adapters.ts';
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
