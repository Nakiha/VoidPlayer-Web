import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceQuerier, sortByAxis, mergeAppendedSort } from '../src/analysis/adapters.ts';
import type { SourceQueryContext } from '../src/analysis/adapters.ts';

function ctxFor(mediaId = 'm1'): SourceQueryContext {
  return {
    mediaId, firstPtsUs: 0, durationUs: 10_000_000,
    sourceVersion: 'v', indexRevision: 0,
    capability: { hasSize: true, hasDts: true, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: 'building' },
    coverageUs: null,
  };
}

function packets(n: number, jitter = 0) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    // 含 B 帧重排的抖动，触发 (t,pos) 稳定序分支
    const pts = i * 40000 + (i % 3 === 0 ? 80000 : i % 3 === 1 ? -40000 : 0) + (jitter ? (i * 7919) % jitter : 0);
    arr.push({ pts, dts: i * 40000, size: 8000 + (i % 7) * 1000, key: i % 30 === 0 });
  }
  return arr;
}

test('REVIEW-04: 增量合并与全量排序一致（含重排与稳定序）', () => {
  const all = packets(5000);
  const full = sortByAxis(all, 0, 'pts');
  const prev = sortByAxis(all.slice(0, 2000), 0, 'pts');
  // 注意：merge 需要原包表引用；这里用全量表 + 旧长 2000 做合并
  const merged = mergeAppendedSort(all, 0, 'pts', prev, 2000);
  assert.deepEqual([...merged.order], [...full.order]);
  assert.deepEqual([...merged.times], [...full.times]);
  assert.deepEqual([...merged.prefix], [...full.prefix]);

  const fullDts = sortByAxis(all, 0, 'dts');
  const prevDts = sortByAxis(all.slice(0, 1000), 0, 'dts');
  const mergedDts = mergeAppendedSort(all, 0, 'dts', prevDts, 1000);
  assert.deepEqual([...mergedDts.order], [...fullDts.order]);
});

test('REVIEW-04: 渐进追加复用缓存，查询结果与全量一致', () => {
  const querier = createSourceQuerier();
  const ctx = ctxFor();
  const arr: { pts: number; dts: number; size: number; key: boolean }[] = [];
  let last: ReturnType<typeof querier> | undefined;
  for (let batch = 0; batch < 5; batch++) {
    for (let i = 0; i < 2000; i++) {
      const idx = batch * 2000 + i;
      arr.push({ pts: idx * 40000, dts: idx * 40000, size: 10000, key: idx % 30 === 0 });
    }
    ctx.sourceVersion = `m1@${arr.length}`;
    ctx.indexRevision = arr.length;
    const r = querier(arr, ctx, {
      requestId: batch + 1, axis: 'pts', startUs: 0, endUs: arr.length * 40000,
      pixelWidth: 320, bitrateWindowUs: 1_000_000, maxSamples: 5000,
    });
    last = r as never;
    assert.ok(r.buckets && r.buckets.length > 0);
    assert.equal(r.buckets.reduce((n, b) => n + b.count, 0), arr.length);
  }
  assert.ok(last);
});

test('REVIEW-04: 大包表渐进查询有界（样本/桶/曲线封顶，不抛全量数组）', () => {
  const querier = createSourceQuerier();
  const ctx = ctxFor('big');
  // 5 万包：模拟长片，查询仍只返回有界结果
  const big = packets(50_000);
  const fullEnd = 50_000 * 40000;
  ctx.durationUs = fullEnd;
  ctx.coverageUs = { start: 0, end: fullEnd };
  ctx.sourceVersion = `big@${big.length}`;
  ctx.indexRevision = big.length;
  const start = performance.now();
  const r = querier(big, ctx, {
    requestId: 1, axis: 'pts', startUs: 0, endUs: fullEnd,
    pixelWidth: 320, bitrateWindowUs: 1_000_000, maxSamples: 5000,
  });
  const ms = performance.now() - start;
  assert.equal(r.truncated, true);
  assert.equal(r.samples.length, 0);
  assert.ok(r.buckets!.length <= 400);
  assert.ok(r.bitrate!.length <= 320);
  // 首个大索引仍是同步任务：这里只断言完成与有界，不设硬性 ms 门限避免 CI 抖动；
  // 渐进复查必须命中增量路径且更快（同一引用追加 2000 后复查）。
  for (let i = 0; i < 2000; i++) big.push({ pts: fullEnd + i * 40000, dts: fullEnd + i * 40000, size: 9000, key: false });
  const fullEnd2 = fullEnd + 2000 * 40000;
  ctx.durationUs = fullEnd2;
  ctx.coverageUs = { start: 0, end: fullEnd2 };
  ctx.sourceVersion = `big@${big.length}`;
  ctx.indexRevision = big.length;
  const t2 = performance.now();
  const r2 = querier(big, ctx, {
    requestId: 2, axis: 'pts', startUs: 0, endUs: fullEnd2,
    pixelWidth: 320, bitrateWindowUs: 1_000_000, maxSamples: 5000,
  });
  const ms2 = performance.now() - t2;
  assert.equal(r2.buckets!.reduce((n, b) => n + b.count, 0), big.length);
  // 增量复查不应比首个全量更慢一个数量级（ CI 抖动下仍应显著更快或相当）
  assert.ok(ms2 <= Math.max(1000, ms * 1.2), `first=${ms.toFixed(1)}ms second=${ms2.toFixed(1)}ms`);
});
