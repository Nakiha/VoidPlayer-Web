import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMediaMismatch, matchMediaIdentity, mediaBasename, mediaMtimeWarning } from '../src/media-identity.ts';

test('identical metadata matches without a warning', () => {
  assert.deepEqual(matchMediaIdentity({ name: 'a/clip.mp4', size: 12, lastModified: 100 }, { name: 'clip.mp4', size: 12, lastModified: 100 }), { ok: true, mtimeChanged: false });
});

test('bare lastModified drift matches with a warning flag', () => {
  assert.deepEqual(matchMediaIdentity({ name: 'clip.mp4', size: 12, lastModified: 100 }, { name: 'clip.mp4', size: 12, lastModified: 200 }), { ok: true, mtimeChanged: true });
});

test('basename is compared, directories are ignored', () => {
  assert.deepEqual(matchMediaIdentity({ name: '/old/dir/clip.mp4', size: 12, lastModified: 100 }, { name: '/new/dir/clip.mp4', size: 12, lastModified: 100 }), { ok: true, mtimeChanged: false });
  const renamed = matchMediaIdentity({ name: 'clip.mp4', size: 12, lastModified: 100 }, { name: 'other.mp4', size: 12, lastModified: 100 });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.deepEqual(renamed.mismatches, [{ field: 'name', expected: 'clip.mp4', actual: 'other.mp4' }]);
});

test('size mismatch fails regardless of other fields', () => {
  const changed = matchMediaIdentity({ name: 'clip.mp4', size: 12, lastModified: 100 }, { name: 'clip.mp4', size: 13, lastModified: 200 });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.deepEqual(changed.mismatches, [{ field: 'size', expected: 12, actual: 13 }]);
  const both = matchMediaIdentity({ name: 'a.mp4', size: 12, lastModified: 100 }, { name: 'b.mp4', size: 13, lastModified: 100 });
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(both.mismatches.length, 2);
});

test('messages name the mismatched field', () => {
  assert.match(describeMediaMismatch('clip.mp4', [{ field: 'size', expected: 12, actual: 13 }]), /大小 12 → 13/);
  assert.match(mediaMtimeWarning('clip.mp4'), /修改时间与工作区记录不一致/);
  assert.equal(mediaBasename('a/b/c.mp4'), 'c.mp4');
});
