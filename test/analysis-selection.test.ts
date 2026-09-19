import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTrackSelection } from '../src/ui/track-selection.ts';

const entry = (slot: string, mediaId = slot.toLowerCase()) => ({ slot, mediaId });

test('元数据更新不覆盖用户显隐：隐藏 B 后时长/偏移变化仍隐藏（F3 回归）', () => {
  const known = new Set<string>();
  // A、B 已载入：默认都加入。
  let r = reconcileTrackSelection([], [entry('A'), entry('B')], known);
  assert.deepEqual(r.selected, ['A', 'B']);
  // 用户隐藏 B；仅 A 的时长更新（FLV 后台索引）不得把 B 加回来。
  r = reconcileTrackSelection(['A'], [entry('A'), entry('B')], known);
  assert.deepEqual(r.selected, ['A']);
  assert.equal(r.changed, false);
  // 偏移调整同理（身份不变）。
  r = reconcileTrackSelection(['A'], [entry('A'), entry('B')], known);
  assert.deepEqual(r.selected, ['A']);
});

test('新增轨道默认出现，移除轨道清理选择，重载同名片视为新轨道', () => {
  const known = new Set<string>();
  let r = reconcileTrackSelection([], [entry('A')], known);
  assert.deepEqual(r.selected, ['A']);
  // 新增 C 默认加入，已隐藏的 B 不受牵连。
  r = reconcileTrackSelection(r.selected, [entry('A'), entry('C')], known);
  assert.deepEqual(r.selected, ['A', 'C']);
  // 移除 C：选择集清理。
  r = reconcileTrackSelection(r.selected, [entry('A')], known);
  assert.deepEqual(r.selected, ['A']);
  // 重新载入同名片：身份被遗忘过，作为新轨道默认可见。
  r = reconcileTrackSelection(r.selected, [entry('A'), entry('C')], known);
  assert.deepEqual(r.selected, ['A', 'C']);
});

test('工作区还原基准：还原时已知身份不被后续同集合事件改动', () => {
  // restoreAnalysisState 用当前轨道身份做基准（模拟 seeds known）。
  const known = new Set<string>(['A|a', 'B|b']);
  // 快照只选了 A；后续元数据/同集合事件不得把 B 加回来。
  const r = reconcileTrackSelection(['A'], [entry('A', 'a'), entry('B', 'b')], known);
  assert.deepEqual(r.selected, ['A']);
  assert.equal(r.changed, false);
});
