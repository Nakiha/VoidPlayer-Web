import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAnalysis } from '../src/ui/analysis-canvas.ts';
import type { CanvasModel } from '../src/ui/analysis-canvas.ts';
import { groupSamples } from '../src/analysis/grouping.ts';
import { layoutMergedSamples } from '../src/ui/analysis-geometry.ts';

function mockCtx(recorded: { fillRect: number[][]; fillText: unknown[][] }) {
  return new Proxy({}, {
    get(_t, p) {
      if (p === 'fillRect') return (...a: number[]) => { recorded.fillRect.push(a); };
      if (p === 'fillText') return (...a: unknown[]) => { recorded.fillText.push(a); };
      if (typeof p === 'string') return (..._a: unknown[]) => {};
      return undefined;
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
}

const colors = { key: '#k', delta: '#d', unknown: '#u', grid: '#g', text: '#t', axisText: '#a' };
// 10 帧，100ms 间隔；yMax 取 1000（niceCeiling 由面板负责，这里直接给定）。
const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 100_000, size: 1000, key: i === 0 }));
function model(viewStart: number, viewEnd: number): CanvasModel {
  return {
    width: 1246, height: 120, viewStart, viewEnd,
    showBitrate: false, showSize: true, colorByType: true,
    tracks: [{ slot: 'A', color: '#slot', samples, truncated: false, buckets: [], bitrate: [], provisional: false }],
    merged: false, yMaxBitrate: 1, yMaxSize: 1000, colors, rubber: null,
  };
}

test('统一几何柱宽一致：缩放不改变视觉柱宽（时间由锚点距离表达）', () => {
  const mediaBySlot = new Map([['A', { mediaId: 'mA', sourceVersion: 'v', indexRevision: 1 }]]);
  const mk = (viewStart: number, viewEnd: number) => {
    const groups = groupSamples([
      {
        slot: 'A', samples: Array.from({ length: 10 }, (_, i) => ({
          sampleId: `A${i}`, axisUs: i * 100_000, sessionPtsUs: i * 100_000,
          sizeBytes: 1000, key: i === 0, decodeOrdinal: i,
          mediaId: 'mA', sourceVersion: 'v', indexRevision: 1,
        })),
      },
    ], 2000);
    const glyphs = layoutMergedSamples(groups, {
      trackOrder: ['A'], viewStart, viewEnd, gutter: 46, plotW: 600,
      rowY: 0, rowH: 60, yMaxSize: 1000, mediaBySlot: mediaBySlot as never,
    });
    const m = model(viewStart, viewEnd);
    m.sampleGlyphs = glyphs as never;
    m.tracks[0].samples = null;
    return m;
  };
  // 视口带 padding，避免边缘裁剪干扰宽度断言（边缘只裁剪不移位，见几何用例）。
  const wide = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  drawAnalysis(mockCtx(wide), mk(-200_000, 1_200_000));
  const narrow = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  drawAnalysis(mockCtx(narrow), mk(-50_000, 150_000));
  const widths = (r: { fillRect: number[][] }) => r.fillRect.map(a => a[2]).filter(w => w >= 5 && w <= 12);
  assert.ok(widths(wide).length > 0 && widths(narrow).length > 0);
  // 同一视口内一致，且缩放不改变目标柱宽。
  assert.deepEqual(new Set(widths(wide)).size, 1);
  assert.deepEqual(new Set(widths(narrow)).size, 1);
  assert.equal(widths(wide)[0], widths(narrow)[0]);
});

test('重复时间戳不产生零宽或异常柱', () => {
  const recorded = { fillRect: [] as number[][], fillText: [] as unknown[][] };
  const m = model(0, 1_000_000);
  m.tracks[0].samples = [
    { t: 0, size: 500, key: true },
    { t: 0, size: 600, key: false },
    { t: 100_000, size: 700, key: false },
  ];
  drawAnalysis(mockCtx(recorded), m);
  assert.ok(recorded.fillRect.length >= 3);
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
