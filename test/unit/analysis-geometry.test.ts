import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSamples } from '../../shared/analysis/metadata/grouping.ts';
import { canLayoutRaw, layoutMergedSamples, layoutMergedBuckets, pickGlyph, valueToY, sampleBarWidth, chartBarWidth, referenceNodeRadius, paddedChartDomain, containerChartColumn, layoutAnalysisCards, floatingAvoidanceShift } from '../../src/ui/analysis/geometry.ts';
import type { Slot } from '../../shared/review/model.ts';

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

test('同一视口柱宽一致：缺席留空', () => {
  // 样本全部取视口内部，避免边缘裁剪干扰宽度断言（边缘行为由专门用例覆盖）。
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', [200_000, 1_000_000]) },
    { slot: 'B', samples: refs('B', [500_000]) },
  ], 2000);
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: ['A', 'B'], viewStart: -500_000, viewEnd: 1_500_000,
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

test('容量复核：低于最小柱宽容量才切到共享桶', () => {
  // 双轨各 90 帧：缩小柱宽后 600px 可逐样本绘制，300px 已不足 1px 柱 + 间隔。
  const aTimes = Array.from({ length: 90 }, (_, i) => i * 33_333);
  const bTimes = Array.from({ length: 90 }, (_, i) => i * 33_333 + 1_000);
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', aTimes) },
    { slot: 'B', samples: refs('B', bTimes) },
  ], 2000);
  assert.ok(groups.length > 50);
  assert.equal(canLayoutRaw(groups, 0, 3_000_000, 46, 600, 2), true);
  assert.equal(canLayoutRaw(groups, 0, 3_000_000, 46, 300, 2), false);
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


test('双轨连续缩放跨过旧 7px 容量阈值，柱宽连续、身份与命中保持一致', () => {
  const times = Array.from({ length: 100 }, (_, i) => 33_333 * i);
  const groups = groupSamples([
    { slot: 'A', samples: refs('A', times) },
    { slot: 'B', samples: refs('B', times.map(t => t + 5000)) },
  ], 2000);
  let previous = Number.POSITIVE_INFINITY;
  for (let span = 150_000; span <= 700_000; span += 1000) {
    const start = 1_000_000 - span / 2, end = start + span;
    const width = sampleBarWidth(groups, start, end, 600, 2);
    assert.ok(width <= previous, `span=${span}, ${previous}->${width}`);
    assert.equal(canLayoutRaw(groups, start, end, 46, 600, 2), true);
    const glyphs = layoutMergedSamples(groups, { trackOrder: ['A', 'B'], viewStart: start, viewEnd: end,
      gutter: 46, plotW: 600, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot });
    const sample = glyphs.find(g => g.sampleId === 'B30')!;
    assert.ok(sample && sample.stackedCount === 1);
    assert.ok(Math.abs(sample.rect.width - width) < 1e-9);
    assert.equal(pickGlyph(glyphs, sample.rect.x + width / 2, 30)?.slot, 'B');
    previous = width;
  }
  assert.ok(previous > 9, `cross-track timestamp skew must not shrink bars: ${previous}`);
});

test('第 0 帧的整柱和参考节点在全片与放大后的左边界完整保留', () => {
  for (const frameUs of [33_333, 1_000_000]) {
    const domain = paddedChartDomain({start:0,end:10_000_000},frameUs,600);
    const groups = groupSamples([{slot:'A',samples:refs('A',[0,frameUs,frameUs*2])}],2000);
    for (const end of [domain.end, Math.max(frameUs,100_000)]) {
      const first = layoutMergedSamples(groups,{trackOrder:['A'],viewStart:domain.start,viewEnd:end,gutter:46,plotW:600,
        rowY:0,rowH:60,yMaxSize:2000,mediaBySlot})[0];
      assert.ok(Math.abs(first.rect.width-chartBarWidth(frameUs/(end-domain.start)*600)) < 1e-9,'first bar retains its full width');
      const center = 46 + (0-domain.start)/(end-domain.start)*600;
      assert.ok(center >= 54,'reference node has at least 8 pixels before time zero');
    }
    const zoomed=paddedChartDomain({start:0,end:10_000_000},frameUs,600,1_000_000);
    assert.ok(-zoomed.start <= Math.max(frameUs/2,1_000_000*8/592)+1,'zooming keeps a half-cell margin instead of magnifying the full-film margin');
  }
});


test('双轨 30fps 的时间戳偏差不压窄柱体，不丢失身份且命中几何互不覆盖', () => {
  for (const skew of [0, 500, 5000, -5000]) {
    const times = Array.from({ length: 30 }, (_, i) => i * 33_333);
    const groups = groupSamples([{ slot: 'A', samples: refs('A', times) }, { slot: 'B', samples: refs('B', times.map(t => t + skew)) }], 2000);
    const width = sampleBarWidth(groups, -50_000, 1_050_000, 1100, 2);
    assert.ok(Math.abs(width - chartBarWidth(33_333 / 2000)) < 1e-6);
    assert.equal(canLayoutRaw(groups, -50_000, 1_050_000, 46, 1100, 2), true);
    const glyphs = layoutMergedSamples(groups, { trackOrder: ['A', 'B'], viewStart: -50_000, viewEnd: 1_050_000, gutter: 46, plotW: 1100, rowY: 0, rowH: 60, yMaxSize: 2000, mediaBySlot });
    assert.equal(glyphs.length, 60);
    const sorted = [...glyphs].sort((a, b) => a.interactionRect.x - b.interactionRect.x);
    for (const [i, glyph] of sorted.entries()) {
      assert.equal(glyph.stackedCount, 1);
      assert.equal(pickGlyph(glyphs, glyph.rect.x + glyph.rect.width / 2, 30)?.slot, glyph.slot);
      if (i) assert.ok(glyph.interactionRect.x >= sorted[i-1].interactionRect.x + sorted[i-1].interactionRect.width - 1e-6);
    }
  }
});


test('reference nodes grow gently and preserve readable layer spacing', () => {
  const small = referenceNodeRadius(12), zoomed = referenceNodeRadius(40), enlarged = referenceNodeRadius(80);
  assert.equal(small, 6, 'overview diameter stays modest at 12px');
  assert.ok(zoomed > small && enlarged > zoomed, 'zooming gradually enlarges nodes');
  assert.ok(enlarged < zoomed * 1.5, 'doubling frame spacing does not double circle size');
  assert.ok(enlarged * 2 < chartBarWidth(80), 'circles remain smaller than wide bars');
  assert.equal(referenceNodeRadius(400), 12, 'extreme zoom caps the diameter at 24px');
});

test('configuration cell precedes frame zero and reserves common empty geometry', () => {
  for (const span of [100_000, 10_000_000, 3_600_000_000]) {
    const raw = { start:0, end:span }, frameUs = 33_333, width = 800;
    const column = containerChartColumn(raw, frameUs);
    const domain = paddedChartDomain({ start:column.timeUs, end:raw.end }, frameUs, width, span);
    const x = (t: number) => (t-domain.start)/(domain.end-domain.start)*width;
    const barWidth = chartBarWidth(column.widthUs/(domain.end-domain.start)*width);
    assert.equal(column.timeUs + column.widthUs, 0);
    assert.equal(column.widthUs, frameUs, 'configuration uses one ordinary frame cell at every zoom');
    assert.equal(barWidth, chartBarWidth(frameUs/(domain.end-domain.start)*width), 'configuration and frame bars have equal widths');
    assert.ok(x(column.timeUs)-barWidth/2 >= 0, 'configuration column is not cropped');
    assert.ok(Math.abs(x(0)-x(column.timeUs)-frameUs/(domain.end-domain.start)*width) < 1e-6, 'configuration sits one frame interval before zero');
    assert.equal(domain.end, span, 'media end is unchanged');
  }
});


test('complete tooltip cards push neighbours and avoid viewport edges', () => {
  const cards = [{ height: 180, preferredTop: 30 }, { height: 120, preferredTop: 160 }, { height: 70, preferredTop: 360 }];
  const layout = layoutAnalysisCards(cards, 8, 500);
  assert.equal(layout.scroll, false);
  assert.equal(layout.tops[0], 30);
  assert.equal(layout.tops[1], 218, 'taller first card pushes the next card down');
  for (const [i, card] of cards.entries()) {
    assert.ok(layout.tops[i] >= 8 && layout.tops[i] + card.height <= 500);
    if (i) assert.ok(layout.tops[i] >= layout.tops[i - 1] + cards[i - 1].height + 8);
  }
  const edge = layoutAnalysisCards(cards.map(c => ({ ...c, preferredTop: 450 })), 8, 500);
  assert.equal(edge.tops[2] + cards[2].height, 500, 'bottom edge moves the stack upwards');
  assert.ok(edge.tops[0] >= 8);
  const short = layoutAnalysisCards(cards, 8, 260);
  assert.equal(short.scroll, true);
  assert.deepEqual(short.tops, [8, 196, 324], 'oversized stack scrolls without cropping any card');
});

test('top-panel floating cards yield to the range editor like the viewport panels', () => {
  const peer = { top: 78, left: 298, right: 638, bottom: 128 };
  assert.equal(floatingAvoidanceShift({ top: 100, left: 700, width: 200, height: 90 }, peer, 720), 0, 'cards to the side of the editor keep their place');
  assert.equal(floatingAvoidanceShift({ top: 150, left: 400, width: 200, height: 90 }, peer, 720), 0, 'cards already clear of the editor keep their place');
  assert.equal(floatingAvoidanceShift({ top: 104, left: 424, width: 204, height: 102 }, peer, 720), 32, 'an overlapping card moves fully below the editor with one gap');
  assert.equal(floatingAvoidanceShift({ top: 100, left: 400, width: 200, height: 30 }, peer, 150), -60, 'a short card moves above the editor when below has no room');
  assert.equal(floatingAvoidanceShift({ top: 88, left: 400, width: 200, height: 200 }, peer, 320), -80, 'when neither side clears, the card clamps towards the roomier side');
  assert.equal(floatingAvoidanceShift({ top: 384, left: 424, width: 204, height: 300 }, { top: 378, left: 298, right: 638, bottom: 428 }, 720), -314, 'cards below the editor move up to keep their full content visible');
});

import {buildAnalysisModel} from '../../src/ui/analysis/model.ts';
import {loadAnalysisPreferences} from '../../src/ui/analysis/preferences.ts';
import {runSourceQuery} from '../../shared/analysis/metadata/adapters.ts';

test('current chart honors merged/rows preferences for three sparse tracks without dropping duplicates or inventing DTS',()=>{
  const sel=([{slot:'A',mediaId:'A'},{slot:'B',mediaId:'B'},{slot:'C',mediaId:'C'}] as const).map(t=>({...t}));
  const sources=[[0,100000,100000],[50000,150000],[0,200000]];
  const results=new Map(sel.map((track,index)=>[track.slot,runSourceQuery(sources[index].map((pts,i)=>({pts,dts:index===0&&i===1?null:pts,size:1000,key:i===0})),{
    mediaId:track.mediaId,sourceVersion:`${track.mediaId}@1`,firstPtsUs:0,durationUs:300000,indexRevision:1,coverageUs:{start:0,end:300000},
    capability:{hasSize:true,hasDts:true,keySource:'container',pictureType:'key-only',qp:'unsupported',indexState:'complete'},
  },{requestId:1,axis:'pts',startUs:0,endUs:300000,pixelWidth:1800,bitrateWindowUs:1000000})]));
  const before=JSON.stringify([...results]),colors={key:'#f00',delta:'#0f0',unknown:'#888',grid:'#444',text:'#fff',axisText:'#aaa'};
  const base={sel,results,range:{start:-100000,end:300000},width:1800,availableHeight:400,slotColors:new Map<Slot,string>(),colors,rubber:null};
  const expected=[...results.values()].flatMap(r=>r.samples.map(s=>s.sampleId)).sort();
  for(const layoutMode of ['merged','rows'] as const){
    const model=buildAnalysisModel({...base,prefs:{...loadAnalysisPreferences(),showSize:true,layoutMode}})!;
    assert.equal(model.merged,layoutMode==='merged');
    if(layoutMode==='rows'){
      assert.equal(model.bucketGlyphs!.reduce((count,g)=>count+g.count,0),expected.length,'the conservative rows LOD retains every queried sample');
      continue;
    }
    assert.deepEqual(model.sampleGlyphs!.flatMap(g=>g.stackedIds).sort(),expected);
    assert.ok(model.groups.some(g=>g.membersByTrack.get('A')?.length===2));
    const dts=buildAnalysisModel({...base,prefs:{...loadAnalysisPreferences(),showSize:true,axis:'dts',layoutMode}})!;
    const missing=results.get('A')!.samples.find(s=>s.dtsUs===null)!.sampleId;
    assert.deepEqual(dts.sampleGlyphs!.flatMap(g=>g.stackedIds).sort(),expected.filter(id=>id!==missing));
  }
  assert.equal(JSON.stringify([...results]),before,'chart projection leaves query ordering and clock facts intact');
});
