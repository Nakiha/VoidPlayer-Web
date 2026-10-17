import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, desiredHeight, drawAnalysis, drawTimeAxis, xOf } from '../../src/ui/analysis/canvas.ts';
import type { CanvasModel } from '../../src/ui/analysis/canvas.ts';
import { groupSamples } from '../../shared/analysis/metadata/grouping.ts';
import { layoutMergedSamples } from '../../src/ui/analysis/geometry.ts';

function mockCtx(recorded: { fillRect: number[][]; fillText: unknown[][]; lineTo?: number[][] }) {
  return new Proxy({}, {
    get(_t, p) {
      if (p === 'fillRect') return (...a: number[]) => { recorded.fillRect.push(a); };
      if (p === 'fillText') return (...a: unknown[]) => { recorded.fillText.push(a); };
      if (p === 'lineTo') return (...a: number[]) => { recorded.lineTo?.push(a); };
      if (typeof p === 'string') return (..._a: unknown[]) => {};
      return undefined;
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
}

const colors = { key: '#k', delta: '#d', unknown: '#u', grid: '#g', text: '#t', axisText: '#a' };

test('单独码率曲线的零线位于绘图区底部，放大面板不留下空白数据区', () => {
  for (const height of [120, 360, 600]) for (const showTimeAxis of [true, false]) {
    const m = { ...model(0, 1_000_000), height, showTimeAxis, showBitrate: true, showSize: false };
    const layout = computeLayout(m);
    assert.equal(layout.bitrate!.h, layout.axisY, 'the rate plot fills all space above the time axis');
    assert.equal(layout.sizeRows.length, 0);
    const recorded = { fillRect: [] as number[][], fillText: [] as unknown[][] };
    drawAnalysis(mockCtx(recorded), m);
    const zero = recorded.fillText.find(args => args[0] === '0');
    assert.equal(zero?.[2], layout.axisY - 10, 'the zero label follows the bottom as the panel grows');
  }
});

test('紧凑概览保留码率和各轨大小行，绘制区域不侵入时间轴', () => {
  for (const count of [1, 2, 4]) {
    const m = model(2_596_000, 3_596_000);
    m.compact = true; m.showBitrate = true;
    m.tracks = Array.from({ length: count }, (_, i) => ({ slot: String(i), color: '#slot', bitrate: [], provisional: false }));
    m.height = desiredHeight(true, count, true);
    assert.ok(m.height < desiredHeight(true, count), 'multi-view height is smaller than the single-view minimum');
    const layout = computeLayout(m);
    assert.ok(layout.bitrate!.h >= 28);
    assert.equal(layout.sizeRows.length, count);
    for (const row of layout.sizeRows) {
      assert.ok(row.h >= 28, 'size rows remain readable');
      assert.ok(row.y >= layout.bitrate!.h && row.y + row.h <= layout.axisY);
    }
  }
});

test('码率和帧大小行在放大面板时等比分配高度，不再限制码率为 140px', () => {
  const m = { ...model(0, 1_000_000), height: 600, compact: true, showTimeAxis: false, showBitrate: true };
  const layout = computeLayout(m);
  assert.equal(layout.bitrate!.h, 300);
  assert.deepEqual(layout.sizeRows.map(row => [row.y, row.h]), [[300, 300]]);
  assert.equal(layout.axisY, 600);
});

test('不同图高共享完全相同的时间刻度和横坐标', () => {
  const m = model(2_596_000, 3_596_000);
  const wide = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  const compact = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  drawTimeAxis(mockCtx(wide), m);
  const shorter = { ...m, height: 58, compact: true };
  drawTimeAxis(mockCtx(compact), shorter);
  assert.ok(wide.fillText.length > 1);
  assert.deepEqual(wide.fillText.map(a => a.slice(0, 2)), compact.fillText.map(a => a.slice(0, 2)));
  for (const time of [m.viewStart, 3_096_000, m.viewEnd]) {
    assert.equal(xOf(m, computeLayout(m), time), xOf(shorter, computeLayout(shorter), time));
  }
});

test('共用轴模式取消重复刻度并把原时间轴高度交还给数据行，网格横坐标保持对齐', () => {
  const single = model(2_596_000, 3_596_000);
  const shared = { ...single, showTimeAxis: false };
  const standalone = { fillRect: [] as number[][], fillText: [] as unknown[][], lineTo: [] as number[][] };
  const gridOnly = { fillRect: [] as number[][], fillText: [] as unknown[][], lineTo: [] as number[][] };
  drawTimeAxis(mockCtx(standalone), single);
  drawTimeAxis(mockCtx(gridOnly), shared);
  assert.ok(standalone.fillText.length > 1);
  assert.equal(gridOnly.fillText.length, 0, 'plot has no duplicate timestamp labels');
  assert.deepEqual(gridOnly.lineTo.map(a => a[0]), standalone.lineTo.map(a => a[0]), 'shared ticks and plot grid remain aligned');
  assert.ok(gridOnly.lineTo.every(a => a[1] === shared.height), 'grid extends through the reclaimed height');
  const original = computeLayout(single), expanded = computeLayout(shared);
  assert.equal(expanded.axisH, 0);
  assert.equal(expanded.sizeRows[0].h - original.sizeRows[0].h, original.axisH);
  assert.equal(desiredHeight(true, 1, true) - desiredHeight(true, 1, true, false), original.axisH);
});
// 10 帧，100ms 间隔；yMax 取 1000（niceCeiling 由面板负责，这里直接给定）。
const mediaBySlot = new Map([['A', { mediaId: 'mA', sourceVersion: 'v', indexRevision: 1 }]]);
const sampleRefs = (times: number[]) => times.map((t, i) => ({
  sampleId: `A${i}`, axisUs: t, sessionPtsUs: t,
  sizeBytes: 1000, key: i === 0, decodeOrdinal: i,
  mediaId: 'mA', sourceVersion: 'v', indexRevision: 1,
}));
function model(viewStart: number, viewEnd: number): CanvasModel {
  return {
    width: 1246, height: 120, viewStart, viewEnd,
    showBitrate: false, showSize: true, colorByType: false,
    tracks: [{ slot: 'A', color: '#slot', bitrate: [], provisional: false }],
    merged: false, yMaxBitrate: 1, yMaxSize: 1000, colors, rubber: null,
  };
}

test('统一几何柱宽随时间单元连续缩放，与 NALU 相同且没有固定上限', () => {
  const mk = (viewStart: number, viewEnd: number) => {
    const groups = groupSamples([{ slot: 'A', samples: sampleRefs(Array.from({ length: 10 }, (_, i) => i * 100_000)) }], 2000);
    const glyphs = layoutMergedSamples(groups, {
      trackOrder: ['A'], viewStart, viewEnd, gutter: 46, plotW: 600,
      rowY: 0, rowH: 60, yMaxSize: 1000, mediaBySlot: mediaBySlot as never,
    });
    const m = model(viewStart, viewEnd);
    m.sampleGlyphs = glyphs as never;
    return m;
  };
  // 视口带 padding，避免边缘裁剪干扰宽度断言（边缘只裁剪不移位，见几何用例）。
  const wide = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  drawAnalysis(mockCtx(wide), mk(-200_000, 1_200_000));
  const narrow = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  drawAnalysis(mockCtx(narrow), mk(-50_000, 150_000));
  assert.ok(![...wide.fillText, ...narrow.fillText].some(a => a[0] === 'K'), 'keyframe bars do not carry low-contrast text');
  const widths = (r: { fillRect: number[][] }) => r.fillRect.map(a => a[2]);
  assert.ok(widths(wide).length > 0 && widths(narrow).length > 0);
  // 同一视口内一致，区间缩小七倍时柱宽也扩大七倍。
  assert.deepEqual(new Set(widths(wide)).size, 1);
  assert.deepEqual(new Set(widths(narrow)).size, 1);
  assert.ok(Math.abs(widths(narrow)[0] / widths(wide)[0] - 7) < 1e-9);
  assert.ok(widths(narrow)[0] > 7);
});

test('重复时间戳不产生零宽或异常柱（glyph 路径）', () => {
  const recorded = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  const groups = groupSamples([{ slot: 'A', samples: sampleRefs([0, 0, 100_000]) }], 2000);
  const m = model(0, 1_000_000);
  m.sampleGlyphs = layoutMergedSamples(groups, {
    trackOrder: ['A'], viewStart: 0, viewEnd: 1_000_000, gutter: 46, plotW: 600,
    rowY: 0, rowH: 60, yMaxSize: 1000, mediaBySlot: mediaBySlot as never,
  }) as never;
  drawAnalysis(mockCtx(recorded), m);
  assert.ok(recorded.fillRect.length >= 1);
  for (const r of recorded.fillRect) {
    assert.ok(Number.isFinite(r[0]) && Number.isFinite(r[2]) && r[2] >= 1, JSON.stringify(r));
  }
});

test('纵轴上限在上、零在下，大小单位为 KiB', () => {
  const recorded = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  const m = model(0, 1_000_000);
  m.yMaxSize = 500_000;
  drawAnalysis(mockCtx(recorded), m);
  const texts = recorded.fillText.map(a => ({ text: String(a[0]), y: Number(a[2]) }));
  const maxLabel = texts.find(t => t.text.includes('KiB'));
  assert.ok(maxLabel, `missing KiB label: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some(t => t.text.match(/^\d+K$/) && !t.text.includes('KiB')), '不得用有歧义的 K');
  const zeroLabel = texts.find(t => t.text === '0');
  assert.ok(zeroLabel, '零刻度缺失');
  assert.ok(maxLabel!.y < zeroLabel!.y, `上限 y=${maxLabel!.y} 应在零 y=${zeroLabel!.y} 之上`);
  assert.ok(maxLabel!.y < 30, `上限应靠近顶部，y=${maxLabel!.y}`);
});
