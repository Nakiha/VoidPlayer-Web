import type { IndexDatabase } from './sqlite.ts';
import type { DirectoryScope } from './library-watch.ts';

export const LIBRARY_RECHECK_MS = 30 * 60 * 1000;
const key = (scope: DirectoryScope) => JSON.stringify([scope.rootId, scope.directory]);
const within = (directory: string) => directory ? ' AND (c.path=? OR substr(c.path,1,?)=?)' : '';
const parameters = (directory: string) => directory ? [directory, directory.length + 1, directory + '/'] : [];
type Observation = DirectoryScope & { recursive: boolean; expires: number };

/** Durable per-directory work, with bounded hints and fair foreground priority.
 * Search strings never enter this queue. Selecting work performs no filesystem IO. */
export class LibraryScanScheduler {
  private observations = new Map<string, Observation>();
  private hints = new Map<string, DirectoryScope>();
  private foreground = 0;
  private db: IndexDatabase;
  private now: () => number;
  private ttlMs: number;
  private settleMs: number;
  constructor(db: IndexDatabase, now: () => number, ttlMs = LIBRARY_RECHECK_MS, settleMs = 0) {
    this.db = db; this.now = now; this.ttlMs = ttlMs; this.settleMs = settleMs;
  }
  observe(scope: DirectoryScope, recursive: boolean) {
    const id = key(scope);
    this.observations.delete(id);
    this.observations.set(id, { ...scope, recursive, expires: this.now() + 60000 });
    if (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
  }
  hint(scope: DirectoryScope) {
    // Overflow is covered by the durable round robin, never by promoting a
    // burst to an unbounded recursive scan.
    if (this.hints.size < 512 || this.hints.has(key(scope))) this.hints.set(key(scope), scope);
  }
  remember(scope: DirectoryScope) {
    this.db.prepare('INSERT OR IGNORE INTO library_directory_checks(root_id,path,next_check_at) VALUES(?,?,?)')
      .run(scope.rootId, scope.directory, this.now());
  }
  private candidate(scope?: DirectoryScope, recursive = false, hinted = false): DirectoryScope | undefined {
    const now = this.now(), values: (string | number)[] = [];
    let filter = 'r.active=1 AND (r.state!=\'offline\' OR c.path=\'\')';
    if (scope) {
      filter += ' AND c.root_id=?'; values.push(scope.rootId);
      filter += recursive ? within(scope.directory) : ' AND c.path=?';
      values.push(...(recursive ? parameters(scope.directory) : [scope.directory]));
      filter += ' AND (c.attempted_at IS NULL OR c.attempted_at<=?)';
      values.push(now - (hinted ? 350 : Math.min(30000, this.ttlMs)));
      // A failed attempt retains its retry deadline even under constant browsing.
      filter += ' AND (c.failed=0 OR c.next_check_at<=?)'; values.push(now);
    } else { filter += ' AND c.next_check_at<=?'; values.push(now); }
    const row = this.db.prepare(`SELECT c.root_id AS rootId,c.path AS directory FROM library_directory_checks c
      JOIN roots r ON r.id=c.root_id WHERE ${filter} ORDER BY c.next_check_at,c.root_id,c.path LIMIT 1`).get(...values);
    return row ? { rootId: String(row.rootId), directory: String(row.directory) } : undefined;
  }
  next(): DirectoryScope | undefined {
    let preferred: DirectoryScope | undefined;
    for (const [id, scope] of this.hints) {
      const candidate = this.candidate(scope, false, true);
      if (candidate) { preferred = candidate; break; }
      // Missing/deleted scopes must not fill the bounded hint queue forever.
      if (!this.db.prepare('SELECT 1 FROM library_directory_checks WHERE root_id=? AND path=?').get(scope.rootId, scope.directory)) this.hints.delete(id);
    }
    for (const [id, observation] of this.observations) {
      if (observation.expires < this.now()) { this.observations.delete(id); continue; }
      preferred ??= this.candidate(observation, observation.recursive);
    }
    if (preferred && this.foreground < 3) { this.foreground++; this.hints.delete(key(preferred)); return preferred; }
    const background = this.candidate();
    if (background) { this.foreground = 0; return background; }
    if (preferred) { this.foreground = 1; this.hints.delete(key(preferred)); return preferred; }
    return undefined;
  }
  finish(scope: DirectoryScope, success: boolean, recursive = false) {
    const now = this.now();
    this.db.prepare(`UPDATE library_directory_checks AS c SET attempted_at=?,checked_at=CASE WHEN ? THEN ? ELSE checked_at END,
      failed=?,next_check_at=? WHERE root_id=?${recursive ? within(scope.directory) : ' AND path=?'}`).run(now, Number(success), now, Number(!success),
      now + (success ? this.ttlMs : Math.min(this.ttlMs, 60000)), scope.rootId,
      ...(recursive ? parameters(scope.directory) : [scope.directory]));
    if (success && this.settleMs > 0) {
      // Pending writes remain durable work even when an in-memory hint burst
      // overflows or the service restarts before the stability timer fires.
      this.db.prepare(`UPDATE library_directory_checks AS c SET next_check_at=MIN(next_check_at,COALESCE(
        (SELECT MIN(m.observed_at)+? FROM media m WHERE m.root_id=c.root_id AND m.parent=c.path AND m.state='pending'),next_check_at))
        WHERE c.root_id=?${recursive ? within(scope.directory) : ' AND c.path=?'}`)
        .run(this.settleMs, scope.rootId, ...(recursive ? parameters(scope.directory) : [scope.directory]));
    }
  }
  prune(scope: DirectoryScope) {
    this.db.prepare(`DELETE FROM library_directory_checks AS c WHERE c.root_id=?${within(scope.directory)}
      AND NOT EXISTS(SELECT 1 FROM directories d WHERE d.root_id=c.root_id AND d.path=c.path)`)
      .run(scope.rootId, ...parameters(scope.directory));
  }
  clear() { this.observations.clear(); this.hints.clear(); this.foreground = 0; }
  get queuedHints() { return this.hints.size; }
}
