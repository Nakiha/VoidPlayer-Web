import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAnalysis } from '../src/ui/analysis-canvas.ts';
import type { CanvasModel } from '../src/ui/analysis-canvas.ts';

function mockCtx(recorded: { fillRect: number[][] }) {
  return new Proxy({}, {
    get(_t, p) {
      if (p === 'fillRect') return (...a: number[]) => { recorded.fillRect.push(a); };
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
    paired: false, yMaxBitrate: 1, yMaxSize: 1000, colors, rubber: null,
  };
}

test('帧柱宽度随缩放变化：放大 10 倍柱宽约 10 倍', () => {
  const wide: { fillRect: number[][] } = { fillRect: [] };
  drawAnalysis(mockCtx(wide), model(0, 1_000_000));
  const narrow: { fillRect: number[][] } = { fillRect: [] };
  drawAnalysis(mockCtx(narrow), model(0, 100_000));
  const maxWidth = (r: { fillRect: number[][] }) => Math.max(...r.fillRect.map(a => a[2]));
  const wWide = maxWidth(wide), wNarrow = maxWidth(narrow);
  // 全览：100ms 占 120px，柱约 108px；放大到 100ms 区间：单帧占满约 1080px。
  assert.ok(wWide > 90 && wWide < 130, `wide=${wWide}`);
  assert.ok(wNarrow > 500, `narrow=${wNarrow}`);
});

test('重复时间戳不产生零宽或异常柱', () => {
  const recorded: { fillRect: number[][] } = { fillRect: [] };
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
