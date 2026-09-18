import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSamples } from '../src/analysis/grouping.ts';
import { layoutMergedSamples, layoutMergedBuckets, pickGlyph, valueToY } from '../src/ui/analysis-geometry.ts';
import type { Slot } from '../src/model.ts';

const mediaBySlot = new Map<Slot, { mediaId: string; sourceVersion: string; indexRevision: number }>([
  ['A', { mediaId: 'mA', sourceVersion: 'mA@5', indexRevision: 5 }],
  ['B', { mediaId: 'mB', sourceVersion: 'mB@5', indexRevision: 5 }],
]);

function refs(slot: Slot, times: number[], sizes: number[] = []) {
  return times.map((t, i) => ({
    sampleId: `${slot}${i}`, axisUs: t, sessionPtsUs: t,
    sizeBytes: sizes[i] ?? 1000, key: null as boolean | null,
    decodeOrdinal: i, mediaId: slot === 'A' ? 'mA' : 'mB',
    sourceVersion: 'v1', indexRevision: 5,
  }));
}

test('60/30fps 统一几何不重叠：B33ms 柱与 A50ms 柱分离', () => {
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0, 16_667, 33_333, 50_000, 66_667]) },
    { slot: 'B', samples: refs('B', [0, 33_333, 66_667]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 200_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  // 同组内 A 总在左、B 总在右；跨组不重叠。
  const at33 = glyphs.filter(g => g.axisUs === 33_333).sort((a, b) => a.rect.x - b.rect.x);
  assert.equal(at33.length, 2);
  assert.equal(at33[0].slot, 'A');
  assert.equal(at33[1].slot, 'B');
  const a50 = glyphs.find(g => g.sampleId === 'A3')!;
  const b33 = glyphs.find(g => g.sampleId === 'B1')!;
  assert.ok(a50.rect.x >= b33.rect.x + b33.rect.width - 0.5, `a50.x=${a50.rect.x} b33=[${b33.rect.x},${b33.rect.width}]`);
});

test('点 B 柱返回 B 身份：不同 PTS 下不误吸 A', () => {
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0]) },
    { slot: 'B', samples: refs('B', [50_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 100_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  const bGlyph = glyphs.find(g => g.slot === 'B')!;
  const cx = bGlyph.interactionRect.x + bGlyph.interactionRect.width / 2;
  const cy = bGlyph.interactionRect.y + bGlyph.interactionRect.height / 2;
  const picked = pickGlyph(glyphs, cx, cy)!;
  assert.equal(picked.slot, 'B');
  assert.equal((picked as { sampleId: string }).sampleId, 'B0');
});

test('单轨柱后半段不误命中下一样本', () => {
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0, 100_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A'], viewStart: 0, viewEnd: 200_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000,
    mediaBySlot: new Map([['A', { mediaId: 'mA', sourceVersion: 'v', indexRevision: 1 }]]),
  });
  const first = glyphs.find(g => g.sampleId === 'A0')!;
  // 第一柱交互单元内偏右仍命中 A0，而不是 A1。
  const x = first.interactionRect.x + first.interactionRect.width * 0.9;
  const picked = pickGlyph(glyphs, x, 30)!;
  assert.equal((picked as { sampleId: string }).sampleId, 'A0');
});

test('同轨重复时间戳可区分，不走覆盖分支', () => {
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0, 0, 100_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A'], viewStart: 0, viewEnd: 200_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000,
    mediaBySlot: new Map([['A', { mediaId: 'mA', sourceVersion: 'v', indexRevision: 1 }]]),
  });
  const dupes = glyphs.filter(g => g.axisUs === 0);
  assert.ok(dupes.length >= 1);
  const total = dupes.reduce((n, g) => n + g.stackedCount, 0);
  assert.equal(total, 2);
  if (dupes.length === 2) {
    assert.notEqual(dupes[0].rect.x, dupes[1].rect.x);
  }
});

test('共享桶同区间并排，不压成同一像素', () => {
  const glyphs = layoutMergedBuckets(new Map([
    ['A', [{ slot: 'A' as Slot, bucketIndex: 0, startUs: 0, endUs: 100_000, count: 3, maxBytes: 500 }]],
    ['B', [{ slot: 'B' as Slot, bucketIndex: 0, startUs: 0, endUs: 100_000, count: 2, maxBytes: 700 }]],
  ]), {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 100_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 1000,
  });
  assert.equal(glyphs.length, 2);
  const [a, b] = glyphs.sort((x, y) => x.rect.x - y.rect.x);
  assert.equal(a.slot, 'A');
  assert.equal(b.slot, 'B');
  assert.ok(a.rect.x + a.rect.width <= b.rect.x + 0.5);
});

test('视口边缘组锚点在外、成员在内仍保留且可命中', () => {
  // 组锚点 99ms、成员 99/101ms，视口从 100ms 开始：101ms 成员不得被整组丢弃。
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [99_000, 500_000]) },
    { slot: 'B', samples: refs('B', [101_000, 500_000]) },
  ], 5000);
  // 99/101 在 5ms 容差下同组，锚点 99ms。
  assert.equal(groups.length, 2);
  const edge = groups[0];
  assert.ok(edge.anchorUs < 100_000);
  assert.ok(edge.memberMaxUs >= 100_000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 100_000, viewEnd: 600_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  const b101 = glyphs.find(g => g.sampleId === 'B0' || g.sampleId === 'B1');
  assert.ok(b101, '视口内 101ms 成员应出现');
  const cx = b101.interactionRect.x + b101.interactionRect.width / 2;
  const picked = pickGlyph(glyphs, cx, 30)!;
  assert.equal(picked.slot, 'B');
});

test('同一视口柱宽一致：稀疏不撑宽、缺席留空', () => {
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0, 1_000_000]) },
    { slot: 'B', samples: refs('B', [500_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 2_000_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  const widths = new Set(glyphs.map(g => Math.round(g.rect.width)));
  assert.equal(widths.size, 1, `柱宽应一致，实际 ${[...widths]}`);
  // 缺席轨道留空：0ms 组只有 A，B 槽位无柱但 A 柱不加宽。
  const at0 = glyphs.filter(g => g.axisUs === 0);
  assert.equal(at0.length, 1);
  assert.equal(at0[0].slot, 'A');
});

test('纵轴映射零在下、上限在上', () => {
  const top = valueToY(0, 100, 100, 100);
  const zero = valueToY(0, 100, 0, 100);
  assert.ok(top < 20, `top=${top}`);
  assert.ok(zero > 80, `zero=${zero}`);
  assert.ok(top < zero);
});
