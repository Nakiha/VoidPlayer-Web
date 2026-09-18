import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitrateAt, bucketize, buildBytePrefixSum, lowerBound, niceCeiling, rangeSumBytes, shouldBucketize,
} from '../src/analysis/statistics.ts';

test('码率滑窗按真实时间窗归集：1s 窗内 1MB 对应 8Mbps', () => {
  // 10 帧，每帧 100KB，均匀分布在 1s 内。
  const times = new Float64Array(Array.from({ length: 10 }, (_, i) => i * 100_000));
  const sizes = new Float64Array(10).fill(100 * 1024);
  const prefix = buildBytePrefixSum(sizes);
  const { mbps, shortWindow, provisional } = bitrateAt(500_000, times, prefix, 1_000_000, { start: 0, end: 1_000_000 }, null);
  assert.equal(shortWindow, false);
  assert.equal(provisional, false);
  assert.ok(mbps !== null && Math.abs(mbps - 8.192) < 1e-9, `mbps=${mbps}`);
});

test('首尾短窗口按实际覆盖时长归一化并标记', () => {
  const times = new Float64Array([0, 500_000]);
  const sizes = new Float64Array([100_000, 100_000]);
  const prefix = buildBytePrefixSum(sizes);
  // t=0 的 1s 居中窗与 [0, 2s) 求交后为 [0, 0.5s)，只覆盖 1 帧。
  const r = bitrateAt(0, times, prefix, 1_000_000, { start: 0, end: 2_000_000 }, null);
  assert.equal(r.shortWindow, true);
  assert.equal(r.provisional, false);
  assert.ok(r.mbps !== null && Math.abs(r.mbps - 1.6) < 1e-9, `mbps=${r.mbps}`);
});

test('窗口跨未覆盖区间时返回 null 而不是偏低码率', () => {
  const times = new Float64Array([0]);
  const prefix = buildBytePrefixSum(new Float64Array([100_000]));
  const r = bitrateAt(500_000, times, prefix, 1_000_000, { start: 0, end: 2_000_000 }, [{ start: 0, end: 400_000 }]);
  assert.equal(r.mbps, null);
  assert.equal(r.provisional, true);
});

test('累计超过 4GiB 不回绕', () => {
  const sizes = new Float64Array([3 * 1024 ** 3, 2 * 1024 ** 3]);
  const prefix = buildBytePrefixSum(sizes);
  assert.equal(prefix[2], 5 * 1024 ** 3);
  const times = new Float64Array([0, 500_000]);
  assert.equal(rangeSumBytes(times, prefix, 0, 1_000_000), 5 * 1024 ** 3);
});

test('概览桶保留峰值帧并区分 sum/count，不冒充单帧', () => {
  const buckets = bucketize([
    { axisUs: 0, sizeBytes: 10_000, key: true, sampleId: 'a0' },
    { axisUs: 10_000, sizeBytes: 500_000, key: false, sampleId: 'a1' },
    { axisUs: 20_000, sizeBytes: 12_000, key: false, sampleId: 'a2' },
  ], 0, 100_000, 100_000);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 3);
  assert.equal(buckets[0].sumBytes, 522_000);
  assert.equal(buckets[0].maxBytes, 500_000);
  assert.equal(buckets[0].maxSampleId, 'a1');
  assert.equal(buckets[0].keyCount, 1);
});

test('分桶锚定固定原点，平移不跳变', () => {
  const samples = [{ axisUs: 150_000, sizeBytes: 1, key: null, sampleId: 'x' }];
  const a = bucketize(samples, 100_000, 200_000, 100_000, 0);
  const b = bucketize(samples, 120_000, 220_000, 100_000, 0);
  assert.equal(a[0].startUs, b[0].startUs);
});

test('LOD：缩略到每像素多样本时只画桶', () => {
  assert.equal(shouldBucketize(432_000, 1000), true);
  assert.equal(shouldBucketize(100, 1000), false);
});

test('lowerBound 边界正确', () => {
  assert.equal(lowerBound(new Float64Array([0, 10, 20]), 10), 1);
  assert.equal(lowerBound(new Float64Array([0, 10, 20]), 15), 2);
});

test('纵轴上取整用细档位，最高柱不低于轴高约 2/3', () => {
  assert.equal(niceCeiling(0), 1);
  assert.equal(niceCeiling(-5), 1);
  assert.equal(niceCeiling(522231), 600000);
  assert.equal(niceCeiling(8.192), 10);
  assert.equal(niceCeiling(19.25), 20);
  assert.equal(niceCeiling(977000), 1000000);
  for (const v of [1, 7, 42, 999, 12345, 3.7e6, 0.02]) {
    const y = niceCeiling(v);
    assert.ok(y >= v && v / y > 0.65, `${v} -> ${y}`);
  }
});
