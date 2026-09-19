// 轨道选择集对账（纯逻辑，无 DOM）。
// 选择只随轨道身份（slot+mediaId）增减变化：新增身份默认加入对比，
// 移除的身份被遗忘（重新载入同名片视为新轨道，默认再次可见）。
// 时长延伸、偏移调整、索引进度等元数据更新不得覆盖用户的显隐选择。

export interface TrackIdentity {
  slot: string;
  mediaId: string;
}

/**
 * 用当前轨道集合对账选择集。known 持有上次见过的身份（调用方所有，
 * 本函数就地更新）。返回是否发生了变化，调用方只在变化时持久化。
 */
export function reconcileTrackSelection(
  selected: readonly string[],
  entries: readonly TrackIdentity[],
  known: Set<string>,
): { selected: string[]; changed: boolean } {
  let changed = false;
  const next = [...selected];
  for (const e of entries) {
    if (!known.has(`${e.slot}|${e.mediaId}`) && !next.includes(e.slot)) {
      next.push(e.slot);
      changed = true;
    }
  }
  const kept = next.filter(s => entries.some(e => e.slot === s));
  if (kept.length !== next.length) changed = true;
  known.clear();
  for (const e of entries) known.add(`${e.slot}|${e.mediaId}`);
  return { selected: kept, changed };
}
