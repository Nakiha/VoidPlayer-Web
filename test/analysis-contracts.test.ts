import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceQuery } from '../src/analysis/adapters.ts';
import { bitrateAtT, localRateAtT, coarsenBucketsShared, isBucketGridCompatible, LOCAL_RATE_WINDOW_US } from '../src/analysis/inspection.ts';
import { canSatisfy, clampPixelWidth, bucketWidthFor } from '../src/analysis/view-cache.ts';
import { ReviewSession } from '../src/session.ts';
import { rgbaDescription } from '../src/frame-description.ts';
import type { MediaSource } from '../src/media.ts';

const cap = { hasSize: true, hasDts: true, keySource: 'container' as const, pictureType: 'key-only' as const, qp: 'unsupported' as const, indexState: 'complete' as const };
function context(duration = 3_000_000) {
  return { mediaId: 'm', firstPtsUs: 0, durationUs: duration, sourceVersion: 'm@1', indexRevision: 1, capability: cap, coverageUs: { start: 0, end: duration } };
}
function query(start: number, end: number, pixels = 1000, extra: Record<string, unknown> = {}) {
  return { requestId: 1, axis: 'pts' as const, startUs: start, endUs: end, pixelWidth: pixels, bitrateWindowUs: 250_000, ...extra };
}
function cfr(n: number, fps = 60) {
  return Array.from({ length: n }, (_, i) => ({ pts: Math.round((i * 1e6) / fps), dts: Math.round((i * 1e6) / fps), size: 1000, key: i % 60 === 0 }));
}

test('R1: halo 与曲线解耦后深度缩放码率读数不再大面积为空', () => {
  const packets = cfr(180);
  const vStart = 1_100_000, vEnd = 1_120_000, plotW = 1000;
  const span = vEnd - vStart;
  const margin = Math.max(span * 0.5, LOCAL_RATE_WINDOW_US / 2);
  const qStart = vStart - margin, qEnd = vEnd + margin;
  const qPix = clampPixelWidth(Math.round(plotW * (qEnd - qStart) / span));
  assert.equal(qPix, 4096);
  const result = runSourceQuery(packets, context(), query(qStart, qEnd, qPix, {
    curveStartUs: vStart, curveEndUs: vEnd, curvePixelWidth: plotW,
  }));
  assert.equal(result.bitrate?.length, plotW);
  assert.ok(result.bitrateStepUs != null && Math.abs(result.bitrateStepUs - span / plotW) < 1);
  assert.deepEqual(result.bitrateRangeUs, { start: vStart, end: vEnd });
  assert.ok(result.sampleCoverageUs && result.sampleCoverageUs.start <= qStart && result.sampleCoverageUs.end >= qEnd);
  let missing = 0;
  for (let i = 0; i < plotW; i++) {
    const t = Math.round(vStart + ((i + 0.5) * span) / plotW);
    const reading = bitrateAtT(result, t, 250_000, span / plotW, 'known');
    if (reading.value === null) missing++;
  }
  assert.equal(missing, 0, `deep-zoom missing=${missing}`);
});

test('R1: 同一 T 跨缩放帧率一致（halo 保证统计窗口）', () => {
  const packets = [...cfr(30, 30), ...cfr(60, 60).map(p => ({ ...p, pts: p.pts + 1_000_000, dts: p.dts + 1_000_000 }))];
  const t = 1_100_000;
  const full = runSourceQuery(packets, context(2_000_000), query(0, 2_000_000));
  const expanded = runSourceQuery(packets, context(2_000_000), query(590_000, 1_610_000, 4096, {
    curveStartUs: 1_090_000, curveEndUs: 1_110_000, curvePixelWidth: 1000,
  }));
  const a = localRateAtT(full, 'pts', t, 'known');
  const b = localRateAtT(expanded, 'pts', t, 'known');
  assert.ok(a.value != null && b.value != null);
  assert.ok(Math.abs(a.value - b.value) < 0.01, `full=${a.value} zoomed=${b.value}`);
  assert.equal(b.provisional, false);
});

test('R1: 裸小区间查询不得报告确定的全窗帧率（显式覆盖）', () => {
  const packets = [...cfr(30, 30), ...cfr(60, 60).map(p => ({ ...p, pts: p.pts + 1_000_000, dts: p.dts + 1_000_000 }))];
  const result = runSourceQuery(packets, context(2_000_000), query(1_050_000, 1_150_000, 100));
  assert.ok(result.sampleCoverageUs);
  assert.deepEqual(result.sampleCoverageUs, { start: 1_050_000, end: 1_150_000 });
  const r = localRateAtT(result, 'pts', 1_100_000, 'known');
  assert.ok(r.value == null || r.provisional === true, `value=${r.value} provisional=${r.provisional}`);
});

test('R1: 缓存按 halo 与曲线分别覆盖与密度判定', () => {
  const cached = {
    slot: 'A', sourceVersion: '1#m@1', indexRevision: 1, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    startUs: 600_000, endUs: 1_620_000, pixelWidth: 4096,
    detailMode: 'raw' as const, bucketWidthUs: 249, truncated: false, sampleCount: 60,
    curveStartUs: 1_100_000, curveEndUs: 1_120_000, curvePixelWidth: 1000,
  };
  // 同 halo 同曲线可复用。
  assert.equal(canSatisfy(cached, {
    startUs: 600_000, endUs: 1_620_000, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 4096, needRaw: true, bucketWidthUs: 249,
    curveStartUs: 1_100_000, curveEndUs: 1_120_000, curvePixelWidth: 1000,
  }), true);
  // 曲线区间未覆盖不可复用。
  assert.equal(canSatisfy(cached, {
    startUs: 600_000, endUs: 1_620_000, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 4096, needRaw: true, bucketWidthUs: 249,
    curveStartUs: 1_100_000, curveEndUs: 1_130_000, curvePixelWidth: 1000,
  }), false);
  // 全览粗曲线不能满足放大的细曲线（旧闪烁根因）。
  const coarse = {
    slot: 'A', sourceVersion: '1#m@1', indexRevision: 1, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    startUs: 0, endUs: 10_000_000, pixelWidth: 1190,
    detailMode: 'raw' as const, bucketWidthUs: 8403, truncated: false, sampleCount: 600,
    curveStartUs: 0, curveEndUs: 10_000_000, curvePixelWidth: 1190,
  };
  assert.equal(canSatisfy(coarse, {
    startUs: 3667604, endUs: 4016372, axis: 'pts', windowUs: 250_000, offsetUs: 0,
    pixelWidth: 2560, needRaw: true, bucketWidthUs: 136,
    curveStartUs: 3667604, curveEndUs: 4016372, curvePixelWidth: 2560,
  }), false);
});

test('R3: 不兼容网格不得合并为完整桶', () => {
  const b = {
    startUs: 15, endUs: 30, count: 1, maxBytes: 100, sumBytes: 100,
    keyCount: 0, deltaCount: 1, unknownCount: 0, complete: true, maxSampleId: 'sample-at-29',
  };
  assert.equal(isBucketGridCompatible([b], 10, 20, 0), false);
  const merged = coarsenBucketsShared([b], 10, 20, 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].complete, false);
  // 对齐网格可合并且保持完整与守恒。
  const mk = (idx: number) => ({
    startUs: idx * 10_000, endUs: (idx + 1) * 10_000, count: 1,
    maxBytes: 1000, sumBytes: 1000, keyCount: 0, deltaCount: 1, unknownCount: 0,
    complete: true, maxSampleId: `s${idx}`,
  });
  const a = [0, 1, 2, 3].map(mk);
  assert.equal(isBucketGridCompatible(a, 10_000, 20_000, 0), true);
  const ca = coarsenBucketsShared(a, 10_000, 20_000, 0);
  assert.deepEqual(ca.map(x => [x.startUs, x.endUs]), [[0, 20_000], [20_000, 40_000]]);
  assert.ok(ca.every(x => x.complete));
  assert.equal(ca.reduce((n, x) => n + x.count, 0), 4);
  assert.equal(ca.reduce((n, x) => n + x.sumBytes, 0), 4000);
});

test('R1: adapter 显式网格契约（bucketGrid/sampleCoverage/bitrateStep）', () => {
  const packets = cfr(10);
  const r = runSourceQuery(packets, context(1_000_000), query(0, 1_000_000, 101, {
    curveStartUs: 0, curveEndUs: 500_000, curvePixelWidth: 50,
  }));
  assert.ok(r.bucketGrid && r.bucketGrid.widthUs > 0);
  assert.deepEqual(r.sampleCoverageUs, { start: 0, end: 1_000_000 });
  assert.deepEqual(r.bitrateRangeUs, { start: 0, end: 500_000 });
  assert.ok(r.bitrateStepUs != null && Math.abs(r.bitrateStepUs - 10_000) < 1);
});

function fakeMedia(name: string, locateImpl: (id: string) => Promise<null | { sampleId: string; decodeOrdinal: number; containerPtsUs: number | null; effectivePtsUs: number | null; dtsUs: number | null; sizeBytes: number | null; randomAccess: 'yes' | 'no' | 'unknown'; pictureType: null; pictureTypeSource: 'unavailable'; qp: null }>) {
  const starts = [0, 40000, 80000];
  const frame = (pts: number) => ({
    ptsUs: pts, sourcePtsUs: pts, durationUs: 40000,
    description: rgbaDescription(10, 10), kind: 'video-sample' as const, width: 10, height: 10, byteSize: 100, close() {},
  });
  const source: MediaSource = {
    info: { id: name, name, size: 10, lastModified: 0, codec: 'test', decoder: 'webcodecs', width: 10, height: 10, firstPtsUs: 0, durationUs: 120000 },
    async frameAt(time: number) {
      const i = Math.max(0, starts.findLastIndex(t => t <= time));
      return frame(starts[i]);
    },
    async framesAfter(pts: number, count: number) { return starts.filter(t => t > pts).slice(0, count).map(frame); },
    async *framesFrom(pts: number) {
      for (let i = Math.max(0, starts.findLastIndex(t => t <= pts)); i < starts.length; i++) yield frame(starts[i]);
    },
    dispose() {},
    locateAnalysisSample: locateImpl,
  };
  return source;
}

test('R2: 慢定位 A 不得覆盖新定位 B 的 seek（可控延迟）', async () => {
  const session = new ReviewSession(() => {});
  let releaseA!: (v: { sampleId: string; decodeOrdinal: number; containerPtsUs: number | null; effectivePtsUs: number | null; dtsUs: number | null; sizeBytes: number | null; randomAccess: 'yes' | 'no' | 'unknown'; pictureType: null; pictureTypeSource: 'unavailable'; qp: null } | null) => void;
  const gateA = new Promise<null | { sampleId: string; decodeOrdinal: number; containerPtsUs: number | null; effectivePtsUs: number | null; dtsUs: number | null; sizeBytes: number | null; randomAccess: 'yes' | 'no' | 'unknown'; pictureType: null; pictureTypeSource: 'unavailable'; qp: null }>(r => { releaseA = r; });
  const source = fakeMedia('m1', id => {
    if (id === 'm1:v:0') return gateA;
    if (id === 'm1:v:2') {
      return Promise.resolve({
        sampleId: id, decodeOrdinal: 2, containerPtsUs: 80000, effectivePtsUs: 80000, dtsUs: 80000,
        sizeBytes: 100, randomAccess: 'no' as const, pictureType: null, pictureTypeSource: 'unavailable' as const, qp: null,
      });
    }
    return Promise.resolve(null);
  });
  try {
    await session.load('A', async () => source);
    const pendingA = session.seekAnalysisSample('A', 'm1:v:0');
    // B 更快完成，应成为最终位置 80000。
    const resB = await session.seekAnalysisSample('A', 'm1:v:2');
    assert.ok('sessionPtsUs' in resB && resB.sessionPtsUs === 80000);
    assert.equal(session.getState().positionUs, 80000);
    // 释放 A：旧意图必须判 stale，不得再次 seek 到 0。
    releaseA({
      sampleId: 'm1:v:0', decodeOrdinal: 0, containerPtsUs: 0, effectivePtsUs: 0, dtsUs: 0,
      sizeBytes: 100, randomAccess: 'no' as const, pictureType: null, pictureTypeSource: 'unavailable' as const, qp: null,
    });
    const resA = await pendingA;
    assert.ok('reason' in resA);
    assert.match(resA.reason, /取代/);
    assert.equal(session.getState().positionUs, 80000);
  } finally { await session.dispose(); }
});

test('R2: 定位等待期间拖动 seek 使旧定位失效', async () => {
  const session = new ReviewSession(() => {});
  let release!: (v: { sampleId: string; decodeOrdinal: number; containerPtsUs: number | null; effectivePtsUs: number | null; dtsUs: number | null; sizeBytes: number | null; randomAccess: 'yes' | 'no' | 'unknown'; pictureType: null; pictureTypeSource: 'unavailable'; qp: null } | null) => void;
  const gate = new Promise<null | { sampleId: string; decodeOrdinal: number; containerPtsUs: number | null; effectivePtsUs: number | null; dtsUs: number | null; sizeBytes: number | null; randomAccess: 'yes' | 'no' | 'unknown'; pictureType: null; pictureTypeSource: 'unavailable'; qp: null }>(r => { release = r; });
  const source = fakeMedia('m1', () => gate);
  try {
    await session.load('A', async () => source);
    const pending = session.seekAnalysisSample('A', 'm1:v:0');
    await session.seek(80000);
    assert.equal(session.getState().positionUs, 80000);
    release({
      sampleId: 'm1:v:0', decodeOrdinal: 0, containerPtsUs: 0, effectivePtsUs: 0, dtsUs: 0,
      sizeBytes: 100, randomAccess: 'no' as const, pictureType: null, pictureTypeSource: 'unavailable' as const, qp: null,
    });
    const res = await pending;
    assert.ok('reason' in res);
    assert.equal(session.getState().positionUs, 80000);
  } finally { await session.dispose(); }
});
