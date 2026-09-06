import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaActionUrl, pinLibraryReference } from '../src/media-reference.ts';
import { SourceCatalog } from '../src/ui/source-catalog.ts';
import type { MediaInfo } from '../src/model.ts';
const id = 'a'.repeat(24), version = 'b'.repeat(24), base = 'https://media.example/player';
const entry = { id, name: 'clip.mp4', root: 'archive', size: 12, lastModified: 12345, version, state: 'ready' };
const info = (url = `/api/media/${id}`) => ({ name: entry.name, size: entry.size, lastModified: entry.lastModified, source: { kind: 'library', id, url } }) as MediaInfo;
const reply = (body = entry) => (async () => Response.json(body)) as typeof fetch;

test('versioned media actions preserve the version and attach paths before query parameters', () => {
  const source = `/api/media/${id}?v=${version}`;
  assert.equal(mediaActionUrl(source, 'download', base), `https://media.example/api/media/${id}?v=${version}&download=1`);
  assert.equal(mediaActionUrl(source, 'reveal', base), `https://media.example/api/media/${id}/reveal?v=${version}`);
});
test('legacy workspace references acquire a version only when size and modification time still match', async () => {
  const pinned = await pinLibraryReference(info(), base, reply());
  assert.equal(pinned.url, `https://media.example/api/media/${id}?v=${version}`);
  await assert.rejects(pinLibraryReference(info(), base, reply({ ...entry, lastModified: 12346 })), /已发生变化/);
  await assert.rejects(pinLibraryReference(info(), base, reply({ ...entry, size: 13 })), /已发生变化/);
});
test('pinned references refuse replacement even when size and mtime match, and aliases migrate', async () => {
  const pinned = info(`/api/media/${id}?v=${version}`);
  await assert.rejects(pinLibraryReference(pinned, base, reply({ ...entry, version: 'c'.repeat(24) })), /已发生变化/);
  await assert.rejects(pinLibraryReference(pinned, base, reply({ ...entry, state: 'pending' })), /仍在写入/);
  assert.equal((await pinLibraryReference(pinned, base, reply({ ...entry, id: 'd'.repeat(24) }))).id, 'd'.repeat(24));
});
test('history preserves versions and refuses a same-size same-time replacement after reload', () => {
  const catalog = new SourceCatalog(); catalog.setLibrary([entry]); catalog.remember(entry, id);
  const restored = new SourceCatalog(catalog.serializable()); restored.setLibrary([{ ...entry, version: 'c'.repeat(24) }]);
  assert.equal(restored.recent()[0].version, version); assert.equal(restored.recent()[0].library, undefined);
  restored.setLibrary([entry]); assert.equal(restored.recent()[0].library?.version, version);
  const legacy = new SourceCatalog([{ ...entry, libraryId: id, version: undefined }]); legacy.setLibrary([entry]);
  assert.equal(legacy.recent()[0].library?.id, id);
});

test('recent entries resolve outside the current directory page and merge migrated aliases', () => {
  const alias = 'c'.repeat(24);
  const catalog = new SourceCatalog([{ ...entry, libraryId: alias, version: undefined }, { ...entry, libraryId: id }]);
  catalog.setLibrary([]); catalog.setRecentLibrary([[alias, entry], [id, entry]]);
  assert.equal(catalog.available().length, 0);
  assert.equal(catalog.recent().length, 1); assert.equal(catalog.recent()[0].library?.id, id);
  assert.equal(catalog.serializable()[0].version, version);
});
