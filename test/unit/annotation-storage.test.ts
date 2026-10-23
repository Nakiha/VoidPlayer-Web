import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationStorage } from '../../src/review/annotation-storage.ts';
import type { AnnotationRecord } from '../../shared/review/annotation-record.ts';

test('a server reset replaces only confirmed state atomically and preserves drafts and other spaces', async () => {
  globalThis.indexedDB = new IDBFactory();
  const storage = new AnnotationStorage();
  const record = (id: string, space: string, revision: number): AnnotationRecord => ({ id, space, revision, sequence: revision, deleted: false, updatedAt: '2026-10-23', updatedBy: 'actor', document: { mark: { id } as never, media: [] } });
  try {
    await storage.remember([record('changed', 'review', 5), record('removed', 'review', 9), record('other', 'elsewhere', 3)]);
    const draft = { key: 'actor/review/window/changed', space: 'review', actor: 'actor', id: 'changed', base: 5, desired: { mark: { id: 'changed', text: 'local unsent edit' } as never, media: [] }, generation: 1 };
    await storage.change(draft.key, () => draft);
    await storage.replaceRecords('review', [record('changed', 'review', 2), record('new', 'review', 4)]);
    assert.deepEqual((await storage.records('review')).map(r => [r.id, r.revision]), [['changed', 2], ['new', 4]]);
    assert.equal((await storage.records('elsewhere'))[0].revision, 3);
    assert.deepEqual(await storage.drafts('review', 'actor'), [draft]);
    await storage.remember([record('changed', 'review', 1)]);
    assert.equal((await storage.records('review')).find(r => r.id === 'changed')!.revision, 2, 'ordinary duplicate/out-of-order delivery cannot regress revisions');
  } finally { storage.close(); }
});
