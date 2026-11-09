export type NaluFilter = { hiddenTypes: Set<number>; soloType?: number };

/** Track-owned selection, independent of the currently discovered type list. */
export function selectNaluType(filter: NaluFilter, type: number | null, solo: boolean, available: readonly number[]) {
  if (type === null) { resetNaluFilter(filter); return; }
  if (solo) {
    const alreadySolo = filter.soloType === type;
    filter.hiddenTypes.clear();
    if (alreadySolo) delete filter.soloType;
    else { filter.soloType = type; discoverNaluTypes(filter, available); }
  } else {
    delete filter.soloType;
    if (filter.hiddenTypes.has(type)) filter.hiddenTypes.delete(type);
    else filter.hiddenTypes.add(type);
  }
}

export function discoverNaluTypes(filter: NaluFilter, available: readonly number[]) {
  if (filter.soloType === undefined) return;
  for (const type of available) if (type !== filter.soloType) filter.hiddenTypes.add(type);
}
export function resetNaluFilter(filter: NaluFilter) { filter.hiddenTypes.clear(); delete filter.soloType; }
