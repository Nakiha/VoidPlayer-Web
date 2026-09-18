import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceQuery } from '../src/analysis/adapters.ts';
import type { SourceQueryContext } from '../src/analysis/adapters.ts';
import { groupSamples } from '../src/analysis/grouping.ts';
import { shouldBucketize } from '../src/analysis/statistics.ts';

const baseCap = {
  hasSize: true, hasDts: true, keySource: 'container' as const,
  pictureType: 'key-only' as const, qp: 'unsupported' as const, indexState: 'complete' as const,
};

function ctxFor(mediaId = 'm1', durationUs = 1_000_000): SourceQueryContext {
  return {
    mediaId, firstPtsUs: 0, durationUs,
    sourceVersion: 'v1', indexRevision: 10, capability: baseCap,
    coverageUs: { start: 0, end: durationUs },
  };
}

test('负 DTS 首包计入正确窗口：10000/1000/1000 字节案例', () => {
  // 完整 DTS 范围 [-40ms,80ms)，样本 [-40ms,0,40ms]。
  const packets = [
    { pts: 0, dts: -40_000, size: 10_000, key: true },
    { pts: 0, dts: 0, size: 1_000, key: false },
    { pts: 40_000, dts: 40_000, size: 1_000, key: false },
  ];
  const ctx = ctxFor('m1', 80_000);
  const r = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'dts', startUs: -40_000, endUs: 80_000,
    pixelWidth: 120, bitrateWindowUs: 80_000,
  });
  assert.equal(r.samples.length, 3);
  // t=0 的 80ms 窗应包括前两包：11000B×8/0.08s = 1.1Mbps。
  const center = r.bitrate!.reduce((a, b) => Math.abs(b.tUs - 0) < Math.abs(a.tUs - 0) ? b : a);
  assert.ok(center.mbps != null && Math.abs(center.mbps - 1.1) < 0.15, `mbps=${center.mbps}@${center.tUs}`);
});

test('PTS/DTS 切换不改 sampleId', () => {
  const packets = [
    { pts: 0, dts: 0, size: 50_000, key: true },
    { pts: 120_000, dts: 40_000, size: 40_000, key: true },
    { pts: 40_000, dts: 80_000, size: 5_000, key: false },
    { pts: 80_000, dts: 120_000, size: 5_000, key: false },
  ];
  const ctx = ctxFor();
  const ptsView = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'pts', startUs: 0, endUs: 200_000, pixelWidth: 50, bitrateWindowUs: 500_000,
  });
  const dtsView = runSourceQuery(packets, ctx, {
    requestId: 2, axis: 'dts', startUs: 0, endUs: 200_000, pixelWidth: 50, bitrateWindowUs: 500_000,
  });
  assert.deepEqual(new Set(ptsView.samples.map(s => s.sampleId)), new Set(dtsView.samples.map(s => s.sampleId)));
});

test('共享桶原点对齐：不同 offset 的会话桶边界一致', () => {
  // 两轨同一媒体时间，offset 不同：归一化原点分别为 0 和 -offset，会话 0 对齐。
  const packets = Array.from({ length: 10 }, (_, i) => ({
    pts: i * 10_000, dts: i * 10_000, size: 1000, key: i === 0,
  }));
  const ctx = ctxFor();
  const width = 10_000;
  const a = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'pts', startUs: 0, endUs: 100_000, pixelWidth: 10,
    bitrateWindowUs: 1_000_000, bucketOriginUs: 0,
  });
  const b = runSourceQuery(packets, ctx, {
    requestId: 2, axis: 'pts', startUs: 0, endUs: 100_000, pixelWidth: 10,
    bitrateWindowUs: 1_000_000, bucketOriginUs: -30_000,
  });
  // 会话 shift 后：a 桶 +0，b 桶 +30000，应对齐到同一会话网格（0 会话原点）。
  const aShifted = a.buckets!.map(x => x.startUs);
  const bShifted = b.buckets!.map(x => x.startUs + 30_000);
  // b 的归一化原点 -30000，桶宽同为 10000，会话边界应与 a 的网格差为桶宽整数倍。
  for (const s of bShifted) {
    const aligned = aShifted.some(t => Math.abs(((s - t) % width + width) % width) < 1);
    assert.ok(aligned, `b会话桶 ${s} 未对齐 a 网格`);
  }
});

test('守恒：样本数/字节/类型计数在 raw/bucket 一致', () => {
  const packets = [
    { pts: 0, dts: 0, size: 10_000, key: true },
    { pts: 10_000, dts: 10_000, size: 500_000, key: false },
    { pts: 20_000, dts: 20_000, size: 12_000, key: false },
  ];
  const ctx = ctxFor('m1', 100_000);
  const r = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'pts', startUs: 0, endUs: 100_000, pixelWidth: 10, bitrateWindowUs: 1_000_000,
  });
  assert.equal(r.samples.length, 3);
  const sumRaw = r.samples.reduce((n, s) => n + (s.sizeBytes ?? 0), 0);
  const sumBucket = r.buckets!.reduce((n, b) => n + b.sumBytes, 0);
  const countBucket = r.buckets!.reduce((n, b) => n + b.count, 0);
  assert.equal(sumRaw, 522_000);
  assert.equal(sumBucket, 522_000);
  assert.equal(countBucket, 3);
  assert.equal(r.buckets!.reduce((n, b) => n + b.keyCount, 0), 1);
  // 分组不丢样本、不复制。
  const groups = groupSamples([
    { slot: 'A', samples: r.samples.map(s => ({
      sampleId: s.sampleId, axisUs: s.effectivePtsUs!, sessionPtsUs: s.effectivePtsUs,
      sizeBytes: s.sizeBytes, key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
      decodeOrdinal: s.decodeOrdinal, mediaId: 'm1', sourceVersion: 'v1', indexRevision: 1,
    })) },
  ], 2000);
  const grouped = groups.flatMap(g => [...g.membersByTrack.values()].flat()).length;
  assert.equal(grouped, 3);
});

test('LOD：36000 样本从 600s 概览到 30s/1s 切回 raw', () => {
  // 600s 概览 1000px：36/px → 桶；30s 1000px：1.2/px → 仍桶（>0.4）；1s 1000px：0.036/px → raw。
  assert.equal(shouldBucketize(36_000, 1000, 2.5), true);
  assert.equal(shouldBucketize(1800, 1000, 2.5), true);
  assert.equal(shouldBucketize(60, 1000, 2.5), false);
});

test('边缘部分桶标暂定，不冒充完整', () => {
  const packets = Array.from({ length: 5 }, (_, i) => ({
    pts: i * 10_000, dts: i * 10_000, size: 1000, key: false,
  }));
  const ctx = ctxFor('m1', 100_000);
  // 查询 [5000,45000) 桶宽 10000：边缘桶 [0,10000)/[40000,50000) 只统计部分，须暂定。
  const r = runSourceQuery(packets, ctx, {
    requestId: 1, axis: 'pts', startUs: 5_000, endUs: 45_000, pixelWidth: 4, bitrateWindowUs: 1_000_000,
  });
  const edge = r.buckets!.filter(b => b.count > 0 && (b.startUs < 5_000 || b.endUs > 45_000));
  assert.ok(edge.length > 0);
  for (const b of edge) assert.equal(b.complete, false);
});
