import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSamples, correspondenceCoverage } from '../src/analysis/grouping.ts';
import type { GroupSampleRef } from '../src/analysis/grouping.ts';

const ref = (
  sampleId: string, axisUs: number, ordinal = 0, slotExtra = '',
): GroupSampleRef => ({
  sampleId, axisUs, sessionPtsUs: axisUs, sizeBytes: 1000,
  key: null, decodeOrdinal: ordinal, mediaId: `m${slotExtra}`, sourceVersion: 'v1', indexRevision: 1,
});

test('同帧率同时间点合并：组内 A0B0、A1B1，顺序稳定', () => {
  const groups = groupSamples([
    { slot: 'A', samples: [ref('a0', 0), ref('a1', 33_333), ref('a2', 66_666)] },
    { slot: 'B', samples: [ref('b0', 0), ref('b1', 33_333), ref('b2', 66_666)] },
  ], 2000);
  assert.equal(groups.length, 3);
  assert.deepEqual([...groups[0].membersByTrack.keys()], ['A', 'B']);
  assert.equal(groups[0].membersByTrack.get('A')![0].sampleId, 'a0');
  assert.equal(groups[0].membersByTrack.get('B')![0].sampleId, 'b0');
});

test('60/30fps 合并保留所有样本：A1/A3 单独成组，不复制 B', () => {
  const groups = groupSamples([
    { slot: 'A', samples: [0, 16_667, 33_333, 50_000, 66_667].map((t, i) => ref(`a${i}`, t, i)) },
    { slot: 'B', samples: [0, 33_333, 66_667].map((t, i) => ref(`b${i}`, t, i)) },
  ], 2000);
  // 期望 5 组：0(A0B0) / 16.667(A1) / 33.333(A2B1) / 50(A3) / 66.667(A4B2)
  assert.equal(groups.length, 5);
  const all = groups.flatMap(g => [...g.membersByTrack.values()].flat().map(s => s.sampleId));
  assert.equal(new Set(all).size, 8);
  assert.equal(all.filter(id => id.startsWith('b')).length, 3);
  assert.ok(!groups[1].membersByTrack.has('B'));
  assert.ok(!groups[3].membersByTrack.has('B'));
});

test('调换轨道顺序仍合并，样本最多出现一次', () => {
  const groups = groupSamples([
    { slot: 'B', samples: [0, 33_333].map((t, i) => ref(`b${i}`, t, i)) },
    { slot: 'A', samples: [0, 16_667, 33_333].map((t, i) => ref(`a${i}`, t, i)) },
  ], 2000);
  const all = groups.flatMap(g => [...g.membersByTrack.values()].flat().map(s => s.sampleId));
  assert.equal(all.length, new Set(all).size);
  assert.equal(groups.length, 3);
});

test('链式吸附被阻止：0/1.9/3.8ms 在 2ms 容差下分成两组', () => {
  const groups = groupSamples([
    { slot: 'A', samples: [ref('a0', 0), ref('a1', 1900), ref('a2', 3800)] },
  ], 2000);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].membersByTrack.get('A')!.length, 2);
  assert.equal(groups[1].membersByTrack.get('A')![0].sampleId, 'a2');
});

test('同轨重复 PTS 不丢失：同一组保留多个成员', () => {
  const groups = groupSamples([
    { slot: 'A', samples: [ref('a0', 0, 0), ref('a1', 0, 1), ref('a2', 100_000, 2)] },
  ], 2000);
  assert.equal(groups[0].membersByTrack.get('A')!.length, 2);
});

test('异起点与 offset 不强配：时间真实保留', () => {
  const groups = groupSamples([
    { slot: 'A', samples: [ref('a0', 5000)] },
    { slot: 'B', samples: [ref('b0', 50_000)] },
  ], 2000);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].anchorUs, 5000);
  assert.equal(groups[1].anchorUs, 50_000);
});

test('对应覆盖率分轨报告，不用较短边冒充 100%', () => {
  const c = correspondenceCoverage(3, 3, 5);
  assert.equal(c.coverageA, 1);
  assert.equal(c.coverageB, 3 / 5);
});
