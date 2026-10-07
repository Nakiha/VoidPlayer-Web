import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceQuerier, sortByAxis, mergeAppendedSort } from '../../src/analysis/adapters.ts';
import type { SourceQueryContext } from '../../src/analysis/adapters.ts';

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


test('native metadata worker matches the shared statistics and owns transferred batches', async () => {
  const { NativeAnalysisClient } = await import('../../src/analysis/native-client.ts');
  const client = new NativeAnalysisClient();
  try {
    const batch = new Float64Array([80_000, 300, 0, 0, 100, 1, 40_000, 200, 0]);
    assert.equal(await client.call('append', { records: batch }, undefined, [batch.buffer]), 3);
    assert.equal(batch.byteLength, 0);
    const context = { ...ctxFor('native'), durationUs: 120_000, capability: { ...ctxFor().capability, hasDts: false }, coverageUs: { start: 0, end: 120_000 } };
    const query = { requestId: 4, axis: 'pts' as const, startUs: 0, endUs: 120_000, pixelWidth: 32, bitrateWindowUs: 250_000 };
    const result = await client.call('query', { context, query });
    assert.deepEqual(result.samples.map(sample => [sample.decodeOrdinal, sample.effectivePtsUs, sample.sizeBytes]), [[1,0,100],[2,40_000,200],[0,80_000,300]]);
    assert.equal(result.indexRevision, 3); assert.equal(result.sourceVersion, 'native@3');
    assert.equal((await client.call('locate', { mediaId: 'native', firstPtsUs: 0, sampleId: 'native:v:0' }))?.effectivePtsUs, 80_000);
    assert.deepEqual(await client.call('rank', { firstPtsUs: 0, axis: 'pts', tUs: 40_000 }), { rank: 1, total: 3, ordinal: 2 });
    assert.equal(await client.call('number', { firstPtsUs: 0, axis: 'dts', number: 0 }), 80_000);
  } finally { client.close(); }
});

test('native analysis cancellation and disposal settle callers while keeping metadata available', async () => {
  const { NativeAnalysisClient } = await import('../../src/analysis/native-client.ts');
  const client = new NativeAnalysisClient(), count = 100_000;
  const batch = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) { batch[i*3] = i*40_000; batch[i*3+1] = 1000; batch[i*3+2] = i%50===0 ? 1 : 0; }
  await client.call('append', { records: batch }, undefined, [batch.buffer]);
  const context = { ...ctxFor('cancel'), durationUs: count*40_000 };
  const query = { requestId: 1, axis: 'pts' as const, startUs: 0, endUs: count*40_000, pixelWidth: 1000, bitrateWindowUs: 1_000_000 };
  const abort = new AbortController();
  const cancelled = client.call('query', { context, query }, abort.signal); abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await client.call('rank', { firstPtsUs: 0, axis: 'pts', tUs: 0 })).total, count);
  const pending = client.call('query', { context, query }); client.close();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(client.call('rank', { firstPtsUs: 0, axis: 'pts', tUs: 0 }), /disposed/);
});
