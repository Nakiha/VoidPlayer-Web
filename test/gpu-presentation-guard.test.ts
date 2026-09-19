import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuPresentationGuard } from '../src/gpu-presentation-guard.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

type FakeSurface = { mode: string; disposed: boolean; dispose(): void };
function fakeSurface(mode: string): FakeSurface {
  return { mode, disposed: false, dispose() { this.disposed = true; } };
}

test('REVIEW-02: 旧初始化在刷新后迟到成功不得提交', async () => {
  const guard = new GpuPresentationGuard<{ name: string }>();
  const entries = new Map<{ name: string }, { surface: FakeSurface }>();
  const firstSurfaceGate = deferred<FakeSurface>();
  let policy: 'browser' | 'reference' = 'browser';

  async function initialize(sources: { name: string }[]) {
    const token = guard.beginInitialize(sources);
    const mode = policy === 'reference' ? 'planes' : 'hybrid';
    const pending = new Map<{ name: string }, FakeSurface>();
    for (const source of sources) {
      const surface = await firstSurfaceGate.promise;
      if (!guard.isCurrent(token)) {
        surface.dispose();
        for (const s of pending.values()) s.dispose();
        return 'stale' as const;
      }
      const owned = fakeSurface(mode);
      pending.set(source, owned);
    }
    if (!guard.isCurrent(token)) {
      for (const s of pending.values()) s.dispose();
      return 'stale' as const;
    }
    for (const [s, surface] of pending) entries.set(s, { surface });
    return 'committed' as const;
  }

  async function refresh() {
    const { token, sources } = guard.beginRefresh();
    // 刷新只清理已提交，不碰在途 pending；本用例提交为空，直接完成
    for (const [, e] of [...entries]) e.surface.dispose();
    entries.clear();
    if (sources.length === 0) return 'refreshed-empty' as const;
    void token;
    return 'refreshed' as const;
  }

  const source = { name: 'A' };
  const startup = initialize([source]);
  assert.equal(entries.size, 0);
  policy = 'reference';
  await refresh();
  // 旧 surface 迟到返回：不得提交
  firstSurfaceGate.resolve(fakeSurface('hybrid-ignored'));
  const result = await startup;
  assert.equal(result, 'stale');
  assert.equal(entries.size, 0);
  assert.equal(guard.sources().length, 1);
});

test('REVIEW-02: 初始化一半时切换，新初始化提交后旧失败只清理自己', async () => {
  const guard = new GpuPresentationGuard<string>();
  const entries = new Map<string, FakeSurface>();
  const secondGate = deferred<FakeSurface>();
  const disposals: string[] = [];

  function tracked(name: string, mode: string): FakeSurface {
    const s = fakeSurface(mode);
    const orig = s.dispose.bind(s);
    s.dispose = () => { orig(); disposals.push(name); };
    return s;
  }

  // 旧初始化：两个 source，第一个立即成功，第二个阻塞
  async function oldInit() {
    const token = guard.beginInitialize(['A', 'B']);
    const pending = new Map<string, FakeSurface>();
    pending.set('A', tracked('old-A', 'hybrid'));
    const second = await secondGate.promise;
    void second;
    if (!guard.isCurrent(token)) {
      for (const [name, s] of pending) { s.dispose(); void name; }
      tracked('old-B-late', 'hybrid').dispose();
      return 'stale' as const;
    }
    for (const [k, v] of pending) entries.set(k, v);
    return 'committed' as const;
  }

  // 新初始化：refresh 后全量成功
  async function newInit() {
    const { token, sources } = guard.beginRefresh();
    void sources;
    const freshToken = guard.beginInitialize(['A', 'B']);
    void token;
    const pending = new Map<string, FakeSurface>();
    pending.set('A', tracked('new-A', 'planes'));
    pending.set('B', tracked('new-B', 'planes'));
    if (!guard.isCurrent(freshToken)) return 'stale' as const;
    for (const [k, v] of pending) entries.set(k, v);
    return 'committed' as const;
  }

  const old = oldInit();
  // 切到 reference：refresh 使旧 epoch 失效
  guard.beginRefresh();
  const committed = await newInit();
  assert.equal(committed, 'committed');
  assert.equal(entries.get('A')?.mode, 'planes');
  assert.equal(entries.get('B')?.mode, 'planes');
  // 旧初始化随后失败/返回：只能清理自己，不得清掉新 entries
  secondGate.resolve(tracked('late-surface', 'hybrid'));
  const oldResult = await old;
  assert.equal(oldResult, 'stale');
  assert.equal(entries.size, 2);
  assert.ok(disposals.includes('old-A'));
  assert.ok(!disposals.includes('new-A') && !disposals.includes('new-B'));
});

test('REVIEW-02: refresh 不从已提交反推 source，空提交仍保留完整列表', () => {
  const guard = new GpuPresentationGuard<string>();
  guard.beginInitialize(['A', 'B']);
  const { sources } = guard.beginRefresh();
  assert.deepEqual(sources, ['A', 'B']);
});
