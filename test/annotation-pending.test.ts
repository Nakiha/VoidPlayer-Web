import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationPendingQueue } from '../src/annotation-pending.ts';
import type { PendingEdit } from '../src/annotation-pending.ts';

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const keyB = 'u1/default/window-1/B';
const valueOld = { id: 'B', document: { mark: { id: 'B' } } as never, base: 0, space: 'default', actorId: 'u1' };
const valueNew = { id: 'B', document: { mark: { id: 'B', text: 'new' } } as never, base: 0, space: 'default', actorId: 'u1' };

test('REVIEW-01: 快照重试不得覆盖中途的新编辑（阻塞 A，中途改 B）', async () => {
  const queue = new AnnotationPendingQueue();
  // 两条旧待办
  const keyA = 'u1/default/window-1/A';
  const pendingA = queue.stage(keyA, { id: 'A', document: { mark: { id: 'A' } } as never, base: 0, space: 'default', actorId: 'u1' });
  const pendingBold = queue.stage(keyB, valueOld);
  const snapshot = queue.snapshot();

  // 模拟 IndexedDB 草稿表：generation 随每次写入递增
  const drafts = new Map<string, { desired: unknown; generation: number }>();
  const writes: string[] = [];
  const gateA = deferred<void>();
  const gateReleaseA = deferred<void>();

  // sync 循环处理快照：第一项 A 的写入阻塞在 refresh 阶段
  const syncLoop = (async () => {
    for (const [key, pending] of snapshot) {
      await queue.runIfCurrent(key, pending, async () => {
        if (key === keyA) {
          writes.push(`write A:${(pending.document as { mark: { id: string } }).mark.id}`);
          drafts.set(key, { desired: pending.document, generation: (drafts.get(key)?.generation ?? 0) + 1 });
          gateA.resolve();
          await gateReleaseA.promise;
        } else {
          writes.push(`write B:${JSON.stringify(pending.document)}`);
          drafts.set(key, { desired: pending.document, generation: (drafts.get(key)?.generation ?? 0) + 1 });
          queue.removeIfCurrent(key, pending);
        }
        if (key === keyA) queue.removeIfCurrent(key, pending);
      });
    }
  })();

  await gateA.promise;
  // 用户在 A 阻塞期间把 B 改成 B-new，并走正常新编辑路径（stage + 写入）
  const pendingBnew = queue.stage(keyB, valueNew);
  assert.notEqual(pendingBnew, pendingBold);
  assert.equal(queue.isCurrent(keyB, pendingBold), false);
  await queue.runIfCurrent(keyB, pendingBnew, async () => {
    writes.push('write B-new');
    drafts.set(keyB, { desired: pendingBnew.document, generation: (drafts.get(keyB)?.generation ?? 0) + 1 });
    queue.removeIfCurrent(keyB, pendingBnew);
  });
  assert.equal((drafts.get(keyB)?.desired as { mark: { text?: string } }).mark.text, 'new');

  gateReleaseA.resolve();
  await syncLoop;

  // 旧 B-old 不得再次写入
  assert.deepEqual(writes, ['write A:A', 'write B-new']);
  assert.equal((drafts.get(keyB)?.desired as { mark: { text?: string } }).mark.text, 'new');
  assert.equal(drafts.get(keyB)?.generation, 1);
  assert.equal(queue.size, 0);
});

test('REVIEW-01: 同 key 并发写串行，新编辑排在旧重试之后并获胜', async () => {
  const queue = new AnnotationPendingQueue();
  const pendingOld = queue.stage(keyB, valueOld);
  const writes: string[] = [];
  const entered = deferred<void>();
  const releaseStorage = deferred<void>();

  const retry = queue.runIfCurrent(keyB, pendingOld, async () => {
    entered.resolve();
    writes.push('retry B-old start');
    await releaseStorage.promise;
    writes.push('retry B-old commit');
  });
  await entered.promise;
  // 旧写执行期间，用户产生新编辑：stage 后排队
  const pendingNew = queue.stage(keyB, valueNew);
  const fresh = queue.runIfCurrent(keyB, pendingNew, async () => {
    writes.push('fresh B-new commit');
  });
  // 此时新写尚未执行（被旧写占住）
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['retry B-old start']);
  releaseStorage.resolve();
  await retry;
  await fresh;
  assert.deepEqual(writes, ['retry B-old start', 'retry B-old commit', 'fresh B-new commit']);
  assert.equal(queue.get(keyB), pendingNew);
});

test('REVIEW-01: 删除意图同样使旧重试失效', async () => {
  const queue = new AnnotationPendingQueue();
  const pendingOld = queue.stage(keyB, valueOld);
  const snapshot = queue.snapshot();
  // 用户删除 B（document=null 即删除意图）
  const pendingDelete = queue.stage(keyB, { id: 'B', document: null, base: 0, space: 'default', actorId: 'u1' });
  assert.equal(queue.isCurrent(keyB, pendingOld), false);
  let wrote = false;
  for (const [key, pending] of snapshot) {
    if (key !== keyB) continue;
    const result = await queue.runIfCurrent(key, pending, async () => { wrote = true; });
    assert.equal(result, 'stale');
  }
  assert.equal(wrote, false);
  assert.equal(queue.get(keyB), pendingDelete);
});

test('不同标注的写入互不阻塞', async () => {
  const queue = new AnnotationPendingQueue();
  const keyA = 'u1/default/window-1/A';
  const pendingA = queue.stage(keyA, { id: 'A', document: null, base: 0, space: 'default', actorId: 'u1' });
  const pendingB = queue.stage(keyB, valueOld);
  const gate = deferred<void>();
  let bDone = false;
  const aWork = queue.runIfCurrent(keyA, pendingA, async () => { await gate.promise; });
  const bWork = queue.runIfCurrent(keyB, pendingB, async () => { bDone = true; });
  await bWork;
  assert.equal(bDone, true);
  gate.resolve();
  await aWork;
});
