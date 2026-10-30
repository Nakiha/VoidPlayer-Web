// Identity and fingerprint are both required: distinct roots must not collapse,
// and a replaced library file must not inherit access from an old history item.
export const sourceKey = (entry: { name: string; size: number; lastModified: number; version?: string }, libraryId?: string, version = entry.version) =>
  JSON.stringify([libraryId ?? null, entry.name, entry.size, entry.lastModified, version ?? null]);

