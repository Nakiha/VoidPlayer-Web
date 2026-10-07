import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketWidthFor, canSatisfy } from '../../src/analysis/view-cache.ts';
import type { ViewCacheEntry } from '../../src/analysis/view-cache.ts';

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

import { createAnalysisQueries } from '../../src/ui/analysis/queries.ts';
import type { AnalysisQuerySnapshot, AnalysisQueryTrack } from '../../src/ui/analysis/queries.ts';
import type { AnalysisQuery, AnalysisResult } from '../../src/analysis/types.ts';

const complete = { hasSize: true, hasDts: false, keySource: 'container', pictureType: 'key-only', qp: 'unsupported', indexState: 'complete' } as const;
function queryHarness(t: { after(fn: () => void): void }) {
  const lifetime = new AbortController();
  const track: AnalysisQueryTrack = { slot: 'A', mediaId: 'first', sourceGen: 1, offsetUs: 0, durationUs: 10_000_000 };
  const state: AnalysisQuerySnapshot = {
    open: true, tracks: [track], selected: [track], capabilities: new Map([['A', complete]]),
    axis: 'pts', windowUs: 1_000_000, range: { start: 0, end: 10_000_000 },
    domain: { start: 0, end: 10_000_000 }, pixelWidth: 1000,
  };
  const requests: { query: AnalysisQuery; resolve(result: AnalysisResult): void; reject(error: Error): void }[] = [];
  let accepted = 0, changes = 0;
  const controller = createAnalysisQueries({
    signal: lifetime.signal, snapshot: () => state,
    query: (_slot, query) => new Promise((resolve, reject) => requests.push({ query, resolve, reject })),
    onResult: () => accepted++, onChange: () => changes++,
  });
  t.after(() => lifetime.abort());
  const result = (index = 0, patch: Partial<AnalysisResult> = {}): AnalysisResult => ({
    requestId: index, sourceVersion: `${state.tracks[0]?.sourceGen ?? 1}#adapter`, indexRevision: 1,
    axis: requests[index].query.axis, origin: { firstPtsUs: 0, offsetUs: state.tracks[0]?.offsetUs ?? 0 },
    samples: [{ sampleId: 'sample', decodeOrdinal: 0, containerPtsUs: 1_000_000, effectivePtsUs: 1_000_000,
      dtsUs: null, sizeBytes: 100, randomAccess: 'yes', pictureType: 'I', pictureTypeSource: 'unavailable', qp: null }],
    truncated: false, buckets: null, bitrate: null, capability: complete,
    coverageUs: { start: 0, end: 10_000_000 }, ...patch,
  });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const replace = (patch: Partial<AnalysisQueryTrack>) => {
    const previous = state.tracks;
    state.tracks = state.selected = [{ ...state.tracks[0], ...patch }];
    return controller.reconcile(previous, state.tracks);
  };
  return { controller, state, requests, result, flush, replace, lifetime, counts: () => ({ accepted, changes }) };
}

test('查询复用完整覆盖，放大时重新获取更细数据，并保留样本邻域与独立曲线网格', async t => {
  const h = queryHarness(t);
  h.controller.refresh(); h.requests[0].resolve(h.result()); await h.flush();
  h.controller.refresh(); assert.equal(h.requests.length, 1, 'complete matching coverage is reused');
  h.state.range = { start: 4_000_000, end: 4_100_000 };
  h.controller.refresh();
  const query = h.requests[1].query;
  assert.equal(query.startUs, 3_500_000); assert.equal(query.endUs, 4_600_000);
  assert.equal(query.curveStartUs, 3_975_000); assert.equal(query.curveEndUs, 4_125_000);
  assert.equal(query.pixelWidth, 4096, 'halo query remains bounded');
  assert.equal(query.curvePixelWidth, 1500, 'curve keeps the visible density');
});

test('覆盖使用请求发出时的码率窗口，迟到结果不能冒充新的窗口', async t => {
  const h = queryHarness(t);
  h.controller.refresh(); h.state.windowUs = 250_000;
  h.requests[0].resolve(h.result()); await h.flush();
  h.controller.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].query.bitrateWindowUs, 250_000);
});

test('换片后丢弃未遵守取消的旧结果和旧错误', async t => {
  const h = queryHarness(t);
  h.controller.refresh();
  h.replace({ mediaId: 'second', sourceGen: 2 });
  assert.equal(h.requests[0].query.signal?.aborted, true);
  h.controller.refresh();
  h.requests[1].resolve(h.result(1)); await h.flush();
  h.requests[0].resolve(h.result(0, { sourceVersion: '1#adapter' })); await h.flush();
  assert.equal(h.controller.results.get('A')?.sourceVersion, '2#adapter');
  h.controller.refresh(); // cached
  h.state.windowUs = 250_000; h.controller.refresh();
  h.replace({ sourceGen: 3 }); h.controller.refresh();
  h.requests[3].resolve(h.result(3)); await h.flush();
  h.requests[2].reject(new Error('old source failed')); await h.flush();
  assert.equal(h.controller.errors.size, 0);
  assert.equal(h.counts().accepted, 2);
});

test('同媒体实例重建、身份变化及移除均清理旧数据，偏移变化只作废覆盖', async t => {
  const h = queryHarness(t);
  h.controller.refresh(); h.requests[0].resolve(h.result()); await h.flush();
  assert.deepEqual(h.replace({ offsetUs: 1000 }), []);
  assert.equal(h.controller.results.size, 1);
  h.controller.refresh(); assert.equal(h.requests.length, 2, 'new offset cannot reuse old projection');
  h.requests[1].resolve(h.result(1)); await h.flush();
  assert.deepEqual(h.replace({ sourceGen: 2 }), ['A']); assert.equal(h.controller.results.size, 0);
  h.controller.refresh(); h.requests[2].resolve(h.result(2)); await h.flush();
  assert.deepEqual(h.replace({ mediaId: 'second' }), ['A'], 'same generation never preserves another media identity');
  h.controller.refresh(); h.requests[3].resolve(h.result(3)); await h.flush();
  const previous = h.state.tracks; h.state.tracks = h.state.selected = [];
  assert.deepEqual(h.controller.reconcile(previous, []), ['A']); assert.equal(h.controller.results.size, 0);
});

test('关闭再打开拒绝旧请求，销毁后不发布结果也不再查询', async t => {
  const h = queryHarness(t);
  h.controller.refresh(); h.state.open = false; h.controller.suspend();
  h.controller.schedule(true); assert.equal(h.requests.length, 1);
  h.state.open = true; h.controller.schedule(true);
  h.requests[0].resolve(h.result()); await h.flush(); assert.equal(h.controller.results.size, 0);
  h.lifetime.abort();
  h.requests[1].resolve(h.result(1)); await h.flush();
  h.controller.schedule(true); h.controller.refresh();
  assert.equal(h.requests.length, 2); assert.equal(h.counts().accepted, 0);
  assert.equal(h.controller.results.size, 0);
});

test('构建中的结果不建立覆盖；查询失败可重试成功并清除错误', async t => {
  const h = queryHarness(t);
  h.controller.refresh(); h.requests[0].resolve(h.result(0, { capability: { ...complete, indexState: 'building' } })); await h.flush();
  h.controller.refresh(); assert.equal(h.requests.length, 2, 'building result cannot suppress a complete query');
  h.requests[1].reject(new Error('temporary failure')); await h.flush();
  assert.equal(h.controller.errors.get('A'), 'temporary failure');
  h.controller.refresh(); h.requests[2].resolve(h.result(2)); await h.flush();
  assert.equal(h.controller.errors.size, 0);
  h.controller.refresh(); assert.equal(h.requests.length, 3);
});

test('不支持与失败索引不发查询，错误不会污染新媒体', async t => {
  const h = queryHarness(t);
  h.state.capabilities = new Map([['A', { ...complete, hasSize: false }]]);
  h.controller.refresh(); assert.equal(h.requests.length, 0);
  h.state.capabilities = new Map([['A', { ...complete, indexState: 'error' }]]);
  h.controller.refresh(); assert.equal(h.requests.length, 0);
  h.state.capabilities = new Map([['A', complete]]);
  h.controller.refresh(); h.requests[0].reject(new Error('failed')); await h.flush();
  h.replace({ mediaId: 'second' }); assert.equal(h.controller.errors.size, 0);
});

test('手势节流的尾查取最新视口，关闭会取消待发尾查', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = queryHarness(t);
  h.controller.schedule(true);
  h.state.range = { start: 1_000_000, end: 2_000_000 }; h.controller.schedule();
  h.state.range = { start: 3_000_000, end: 4_000_000 }; h.controller.schedule();
  assert.equal(h.requests.length, 1);
  t.mock.timers.tick(100);
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].query.curveStartUs, 2_750_000);
  assert.equal(h.requests[0].query.signal?.aborted, true);
  h.controller.schedule(); h.state.open = false; h.controller.suspend();
  t.mock.timers.tick(100); assert.equal(h.requests.length, 2);
});
