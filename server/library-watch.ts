import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';

export interface DirectoryScope { rootId: string; directory: string }
const contains = (parent: string, child: string) => !parent || child === parent || child.startsWith(parent + '/');

/** Bounded hints, never an authoritative account of additions or deletions. */
export class DirectoryChanges {
  private roots = new Map<string, Set<string>>();
  add({ rootId, directory }: DirectoryScope) {
    let paths = this.roots.get(rootId);
    if (!paths) this.roots.set(rootId, paths = new Set());
    if ([...paths].some(p => contains(p, directory))) return;
    for (const p of paths) if (contains(directory, p)) paths.delete(p);
    paths.add(directory);
    if (paths.size > 128) { paths.clear(); paths.add(''); }
  }
  take(): DirectoryScope[] {
    const result = [...this.roots].flatMap(([rootId, paths]) => [...paths].map(directory => ({ rootId, directory })));
    this.roots.clear(); return result;
  }
  clear() { this.roots.clear(); }
  get size() { return [...this.roots.values()].reduce((n, paths) => n + paths.size, 0); }
}

/** Watch only directories already checked by the scanner, without recursive OS
 * traversal through symlinks. Unwatched paths remain covered by calibration. */
export class DirectoryWatchHints {
  private handles = new Map<string, { rootId: string; directory: string; identity: string; handle: FSWatcher }>();
  private unseen = new Map<string, Set<string>>();
  private failures = new Set<string>();
  private capped = new Set<string>();
  private changed: (scope: DirectoryScope) => void;
  private limit: number;
  constructor(changed: (scope: DirectoryScope) => void, limit = 512) { this.changed = changed; this.limit = limit; }
  beginRoot(rootId: string) {
    this.unseen.set(rootId, new Set([...this.handles].filter(([, record]) => record.rootId === rootId).map(([key]) => key)));
    this.failures.delete(rootId); this.capped.delete(rootId);
  }
  finishRoot(rootId: string, complete: boolean) {
    if (complete) for (const key of this.unseen.get(rootId) ?? []) {
      const record = this.handles.get(key); this.handles.delete(key); record?.handle.close();
    }
    this.unseen.delete(rootId);
  }
  resetRoot(rootId: string) {
    for (const [key, record] of this.handles) if (record.rootId === rootId) { this.handles.delete(key); record.handle.close(); }
    this.failures.delete(rootId); this.capped.delete(rootId); this.unseen.delete(rootId);
  }
  prune(scope: DirectoryScope, exists: (directory: string) => boolean) {
    for (const [key, record] of this.handles) if (record.rootId === scope.rootId && contains(scope.directory, record.directory) && !exists(record.directory)) {
      this.handles.delete(key); record.handle.close();
    }
  }
  add(scope: DirectoryScope, absolute: string, identity = absolute) {
    const key = JSON.stringify([scope.rootId, scope.directory]);
    this.unseen.get(scope.rootId)?.delete(key);
    const previous = this.handles.get(key);
    if (previous?.identity === identity || this.failures.has(scope.rootId)) return;
    if (previous) { this.handles.delete(key); previous.handle.close(); }
    if (this.handles.size >= this.limit) { this.capped.add(scope.rootId); return; }
    try {
      const handle = watch(absolute, { persistent: false, recursive: false }, () => {
        if (this.handles.get(key)?.handle === handle) this.changed(scope);
      });
      this.handles.set(key, { ...scope, identity, handle });
      handle.on('error', () => {
        if (this.handles.get(key)?.handle !== handle) return;
        this.handles.delete(key); handle.close(); this.failures.add(scope.rootId);
        this.changed(scope);
      });
      // Some platforms activate subscriptions asynchronously. Recheck once
      // after registration; unchanged watchers do not schedule more scans.
      this.changed(scope);
    } catch { this.failures.add(scope.rootId); }
  }
  status() { return { active: this.handles.size, limit: this.limit, limited: this.capped.size > 0, unavailableRoots: [...this.failures] }; }
  close() { const records = [...this.handles.values()]; this.handles.clear(); for (const { handle } of records) handle.close(); this.failures.clear(); this.capped.clear(); this.unseen.clear(); }
}
