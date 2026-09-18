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
  assert.equal(canSatisfy(raw, {
    startUs: 5_000_000, endUs: 10_000_000, axis: 'pts', windowUs: 1_000_000, offsetUs: 0,
    pixelWidth: 1000, needRaw: true, bucketWidthUs: 5000,
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
