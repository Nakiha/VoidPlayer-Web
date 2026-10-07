import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTrackSelection } from '../../src/ui/track-selection.ts';

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

import { installLazyAnalysisPanel } from '../../src/ui/analysis/lazy-panel.ts';
import type { ReviewSession } from '../../src/session.ts';
import type { AnalysisViewState } from '../../src/workspace-file.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lazyFixture() {
  const lifetime = new AbortController(), errors: unknown[] = [], mounts: AnalysisViewState[] = [];
  let loads = 0, mountedState: AnalysisViewState | undefined;
  const entries = [entry('A'), entry('B')];
  const session = { getAnalysisCapabilities: () => entries } as unknown as ReviewSession;
  const module = { installAnalysisPanel: () => ({ setOpen() {}, getAnalysisState: () => structuredClone(mountedState!),
    restoreAnalysisState: (state: AnalysisViewState) => { mountedState = structuredClone(state); mounts.push(mountedState); } }) };
  const pending = deferred<typeof module>();
  const lazy = installLazyAnalysisPanel(session, async action => { try { await action(); } catch (error) { errors.push(error); } },
    { signal: lifetime.signal, isOpen: () => false }, () => { loads++; return pending.promise; });
  return { lazy, pending, module, lifetime, mounts, errors, entries, loads: () => loads };
}

test('unloaded analysis preserves workspace preferences and applies the latest restore during import', async () => {
  const f = lazyFixture();
  const snapshot = f.lazy.getAnalysisState();
  assert.deepEqual(snapshot.selected, ['A', 'B']); assert.equal(f.loads(), 0);
  snapshot.selected = ['A']; snapshot.view = { start: 10, end: 20 };
  f.lazy.restoreAnalysisState(snapshot); snapshot.selected.push('B');
  assert.deepEqual(f.lazy.getAnalysisState().selected, ['A'], 'caller mutation does not change restored selection');
  f.lazy.setOpen(true); assert.equal(f.loads(), 1);
  const newer = f.lazy.getAnalysisState(); newer.view = { start: 30, end: 40 };
  f.lazy.restoreAnalysisState(newer);
  f.pending.resolve(f.module); await f.lazy.ready();
  assert.equal(f.mounts.length, 1); assert.deepEqual(f.mounts[0].view, { start: 30, end: 40 });
  assert.deepEqual(f.mounts[0].selected, ['A']);
});

test('closing or disposing during analysis import does not mount stale UI and a later open retries', async () => {
  const f = lazyFixture(); f.lazy.setOpen(true); const ready = f.lazy.ready(); f.lazy.setOpen(false);
  f.pending.resolve(f.module); await ready;
  assert.equal(f.mounts.length, 0);
  f.lazy.setOpen(true); await f.lazy.ready(); assert.equal(f.mounts.length, 1);
  const disposed = lazyFixture(); disposed.lazy.setOpen(true); disposed.lifetime.abort();
  disposed.pending.resolve(disposed.module); await disposed.lazy.ready(); assert.equal(disposed.mounts.length, 0);
  const failed = lazyFixture(); failed.lazy.setOpen(true); failed.pending.reject(new Error('chunk failed'));
  await assert.rejects(failed.lazy.ready(), /chunk failed/); assert.equal(failed.errors.length, 1);
});
