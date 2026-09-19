import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketWidthFor, canSatisfy } from '../src/analysis/view-cache.ts';
import type { ViewCacheEntry } from '../src/analysis/view-cache.ts';

const base: ViewCacheEntry = {
  slot: 'A', sourceVersion: 'm@10', indexRevision: 10,
  axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
  startUs: 0, endUs: 600_000_000, pixelWidth: 2000,
  detailMode: 'buckets', bucketWidthUs: 300_000, truncated: true, sampleCount: 0,
};

test('2000点/600s 的粗桶不能满足 2000点/30s 的细请求', () => {
  const ok = canSatisfy(base, {
    startUs: 0, endUs: 30_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 2000, needRaw: false, bucketWidthUs: bucketWidthFor(0, 30_000_000, 2000),
  });
  assert.equal(ok, false);
});

test('同范围同分辨率的桶可以复用', () => {
  const cached: ViewCacheEntry = {
    ...base, startUs: 0, endUs: 30_000_000, pixelWidth: 2000,
    bucketWidthUs: bucketWidthFor(0, 30_000_000, 2000),
  };
  const ok = canSatisfy(cached, {
    startUs: 0, endUs: 30_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 2000, needRaw: false, bucketWidthUs: bucketWidthFor(0, 30_000_000, 2000),
  });
  assert.equal(ok, true);
});

test('raw 请求只能由完整 raw 满足，桶再细也不行', () => {
  const ok = canSatisfy(base, {
    startUs: 0, endUs: 1_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 1000, needRaw: true, bucketWidthUs: 1000,
  });
  assert.equal(ok, false);
  const raw: ViewCacheEntry = {
    ...base, startUs: 0, endUs: 30_000_000, pixelWidth: 2000,
    detailMode: 'raw', bucketWidthUs: 15_000, truncated: false, sampleCount: 100,
  };
  // 同分辨率（15ms/px）平移可复用。
  assert.equal(canSatisfy(raw, {
    startUs: 5_000_000, endUs: 10_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 333, needRaw: true, bucketWidthUs: 5000,
  }), true);
});

test('全览 raw 的粗码率步长不能满足放大后的 raw 请求（值/—闪烁根因）', () => {
  // 全览 10s/1190px（约 8.4ms/px，码率点同间距）；放大到 174ms 视图，
  // 查询约 0.14ms/px。粗覆盖必须判为不满足，触发细查。
  const fullRaw: ViewCacheEntry = {
    slot: 'A', sourceVersion: 'm@10', indexRevision: 10,
    axis: 'pts', windowUs: 250_000, offsetUs: 0,
    startUs: 0, endUs: 10_000_000, pixelWidth: 1190,
    detailMode: 'raw', bucketWidthUs: 8403, truncated: false, sampleCount: 600,
  };
  assert.equal(canSatisfy(fullRaw, {
    startUs: 3667604, endUs: 4016372, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 2560, needRaw: true, bucketWidthUs: 136,
  }), false);
  // 同密度复查可以复用。
  assert.equal(canSatisfy({ ...fullRaw, startUs: 3667604, endUs: 4016372, pixelWidth: 2560 }, {
    startUs: 3667604, endUs: 4016372, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 2560, needRaw: true, bucketWidthUs: 136,
  }), true);
});

test('轴/窗口/偏移不一致不可复用', () => {
  const req = {
    startUs: 0, endUs: 1_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 1000, needRaw: false, bucketWidthUs: 1000,
  };
  assert.equal(canSatisfy({ ...base, axis: 'pts' }, { ...req, axis: 'dts' }), false);
  assert.equal(canSatisfy(base, { ...req, windowUs: 500_000 }), false);
  assert.equal(canSatisfy(base, { ...req, offsetUs: 1000 }), false);
});

test('raw 缓存的粗桶网格/粗码率步长不能满足更细的聚合请求（F5 回归）', () => {
  // 100s/100px 的 raw 缓存：桶宽 1s、码率步长约 1s。面板不会用缓存 raw
  // 按新口径重算桶与码率序列，因此聚合请求也必须分别比较桶网格与时间分辨率。
  const raw: ViewCacheEntry = {
    slot: 'A', sourceVersion: 'm@4000', indexRevision: 4000,
    axis: 'pts', windowUs: 250_000, offsetUs: 0,
    startUs: 0, endUs: 100_000_000, pixelWidth: 100,
    detailMode: 'raw', bucketWidthUs: 1_000_000, truncated: false, sampleCount: 4000,
  };
  assert.equal(canSatisfy(raw, {
    startUs: 40_000_000, endUs: 60_000_000, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 100, needRaw: false, bucketWidthUs: 200_000,
  }), false);
  // 同范围同网格同分辨率的聚合复查仍可复用。
  const sameGrid: ViewCacheEntry = { ...raw, startUs: 40_000_000, endUs: 60_000_000, bucketWidthUs: 200_000 };
  assert.equal(canSatisfy(sameGrid, {
    startUs: 40_000_000, endUs: 60_000_000, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 100, needRaw: false, bucketWidthUs: 200_000,
  }), true);
});

test('区间未被完整覆盖不可复用', () => {
  const cached: ViewCacheEntry = {
    ...base, startUs: 0, endUs: 10_000_000, pixelWidth: 1000,
    detailMode: 'raw', truncated: false, sampleCount: 10, bucketWidthUs: 10_000,
  };
  assert.equal(canSatisfy(cached, {
    startUs: 5_000_000, endUs: 20_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 1000, needRaw: true, bucketWidthUs: 15_000,
  }), false);
});
