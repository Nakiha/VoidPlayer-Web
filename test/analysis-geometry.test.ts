import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSamples } from '../src/analysis/grouping.ts';
import { canLayoutRaw, layoutMergedSamples, layoutMergedBuckets, pickGlyph, valueToY } from '../src/ui/analysis-geometry.ts';
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
  // 样本全部取视口内部，避免边缘裁剪干扰宽度断言（边缘行为由专门用例覆盖）。
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [200_000, 1_000_000]) },
    { slot: 'B', samples: refs('B', [500_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 2_000_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  const widths = new Set(glyphs.map(g => Math.round(g.rect.width)));
  assert.equal(widths.size, 1, `柱宽应一致，实际 ${[...widths]}`);
  // 缺席轨道留空：200ms 组只有 A，B 槽位无柱但 A 柱不加宽。
  const at200 = glyphs.filter(g => g.axisUs === 200_000);
  assert.equal(at200.length, 1);
  assert.equal(at200[0].slot, 'A');
});

test('视口边缘只裁剪不移位：左半单元在外不把整组搬进视口', () => {
  // A/B 同在 0ms（视口起点），单元以锚点为中心：A lane 完全在外、B lane 可见。
  // 不得把整组右移 8px 让 A 也出现；绘图与命中共用裁剪后几何。
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0]) },
    { slot: 'B', samples: refs('B', [0]) },
  ], 2000);
  assert.equal(groups.length, 1);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: 0, viewEnd: 200_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  // A 柱被裁掉（不移位），B 柱保留且左缘不早于绘图区。
  assert.equal(glyphs.filter(g => g.slot === 'A').length, 0);
  const b = glyphs.filter(g => g.slot === 'B');
  assert.equal(b.length, 1);
  assert.ok(b[0].rect.x >= 46 - 0.5, `b.x=${b[0].rect.x}`);
  const cx = b[0].interactionRect.x + b[0].interactionRect.width / 2;
  assert.equal(pickGlyph(glyphs, cx, 30)!.slot, 'B');
});

test('容量复核：600px/3s/双30fps 不允许 raw（固定 7px 会重叠约 5.67px）', () => {
  // 双轨各 90 帧、锚点约 33ms 间隔：600px/3s 下锚点间距约 6.6px，远小于双轨单元 16px。
  const aTimes = Array.from({ length: 90 }, (_, i) => i * 33_333);
  const bTimes = Array.from({ length: 90 }, (_, i) => i * 33_333 + 1_000);
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', aTimes) },
    { slot: 'B', samples: refs('B', bTimes) },
  ], 2000);
  assert.ok(groups.length > 50);
  assert.equal(canLayoutRaw(groups, 0, 3_000_000, 46, 600, 2), false);
  // 同样数据放大 10 倍宽度后可以 raw。
  assert.equal(canLayoutRaw(groups, 0, 3_000_000, 46, 6000, 2), true);
});

test('孤立近邻做局部聚合：重叠段标记可展开，相邻正常组不受影响', () => {
  // 正常 100ms 间隔中混入一对相距 5ms 的组（容差 2ms 下分属两组，
  // 但 16px 固定单元重叠）：只合并该段，不污染全图。
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [0, 100_000, 105_000, 200_000]) },
    { slot: 'B', samples: refs('B', [0, 200_000]) },
  ], 2000);
  assert.equal(groups.length, 4);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: -50_000, viewEnd: 250_000,
    gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot,
  });
  // 100ms 附近的 A 两帧应合并为聚合标记（带区间），远端 0/200ms 保持单样本。
  const singles = glyphs.filter(g => g.stackedCount === 1);
  assert.ok(singles.some(g => g.axisUs === 0), '远端 0ms 应保留单样本');
  assert.ok(singles.some(g => g.axisUs === 200_000), '远端 200ms 应保留单样本');
  const aggs = glyphs.filter(g => g.stackedCount > 1 && g.clusterStartUs != null);
  assert.ok(aggs.length >= 1, `应有局部聚合标记，实际 ${glyphs.length} 个 glyph`);
  for (const a of aggs) {
    assert.ok(a.clusterEndUs! > a.clusterStartUs!);
    assert.equal(a.sessionPtsUs, null);
  }
  // 聚合标记之间、与相邻单柱之间不重叠。
  const rects = glyphs.map(g => g.rect).sort((x, y) => x.x - y.x);
  for (let i = 1; i < rects.length; i++) {
    assert.ok(rects[i].x + 0.5 >= rects[i - 1].x + rects[i - 1].width - 0.5,
      `glyph ${i - 1} 与 ${i} 重叠`);
  }
});

test('纵轴映射零在下、上限在上', () => {
  const top = valueToY(0, 100, 100, 100);
  const zero = valueToY(0, 100, 0, 100);
  assert.ok(top < 20, `top=${top}`);
  assert.ok(zero > 80, `zero=${zero}`);
  assert.ok(top < zero);
});
