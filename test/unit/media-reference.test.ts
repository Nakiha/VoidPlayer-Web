import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaActionUrl, pinLibraryReference } from '../../shared/media/io/media-reference.ts';
import { SourceCatalog } from '../../src/ui/source-catalog.ts';
import type { MediaInfo } from '../../shared/review/model.ts';
import { LibraryAccessError } from '../../shared/media/io/source-access.ts';
import { libraryAccessMessage } from '../../src/ui/source-access-message.ts';
const id = 'a'.repeat(24), version = 'b'.repeat(24), base = 'https://media.example/player';
const entry = { id, name: 'clip.mp4', root: 'archive', size: 12, lastModified: 12345, version, state: 'ready' };
const info = (url = `/api/media/${id}`) => ({ name: entry.name, size: entry.size, lastModified: entry.lastModified, source: { kind: 'library', id, url } }) as MediaInfo;
const reply = (body = entry) => (async () => Response.json(body)) as typeof fetch;

test('versioned media actions preserve the version and attach paths before query parameters', () => {
  const source = `/api/media/${id}?v=${version}`;
  assert.equal(mediaActionUrl(source, 'download', base), `https://media.example/api/media/${id}?v=${version}&download=1`);
  assert.equal(mediaActionUrl(source, 'reveal', base), `https://media.example/api/media/${id}/reveal?v=${version}`);
});
test('legacy workspace references acquire a version when size still matches, warning on mtime drift', async () => {
  const pinned = await pinLibraryReference(info(), base, reply());
  assert.equal(pinned.url, `https://media.example/api/media/${id}?v=${version}`);
  assert.equal(pinned.mtimeChanged, false);
  const drifted = await pinLibraryReference(info(), base, reply({ ...entry, lastModified: 12346 }));
  assert.equal(drifted.url, `https://media.example/api/media/${id}?v=${version}`);
  assert.equal(drifted.mtimeChanged, true);
  await assert.rejects(pinLibraryReference(info(), base, reply({ ...entry, size: 13 })), /大小 12 → 13/);
});
test('pinned references survive version rotation with identical bytes, still refuse replacement', async () => {
  const pinned = info(`/api/media/${id}?v=${version}`);
  const rotated = await pinLibraryReference(pinned, base, reply({ ...entry, version: 'c'.repeat(24) }));
  assert.equal(rotated.url, `https://media.example/api/media/${id}?v=${'c'.repeat(24)}`);
  assert.equal(rotated.mtimeChanged, false);
  await assert.rejects(pinLibraryReference(pinned, base, reply({ ...entry, size: 13 })), /已发生变化/);
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

test('missing and disconnected references share reasons between history and workspace restore', async () => {
  const catalog = new SourceCatalog([{ ...entry, libraryId: id }]);
  for (const kind of ['missing', 'unavailable'] as const) {
    catalog.setRecentLibrary([], [[id, kind]]);
    assert.equal(catalog.recent()[0].libraryId, id);
    assert.equal(catalog.recent()[0].libraryProblem, kind);
    const request = kind === 'missing' ? async () => new Response('', { status: 404 }) : async () => { throw new Error('offline'); };
    await assert.rejects(pinLibraryReference(info(), base, request as typeof fetch), error => error instanceof LibraryAccessError && error.kind === kind && error.message === libraryAccessMessage(entry.name, kind));
  }
  catalog.setRecentLibrary([[id, { ...entry, version: 'c'.repeat(24) }]]);
  assert.equal(catalog.recent()[0].libraryProblem, 'changed');
  catalog.setRecentLibrary([[id, entry]]);
  assert.equal(catalog.recent()[0].libraryProblem, undefined);
  assert.equal(catalog.recent()[0].library?.id, id);
  await assert.rejects(pinLibraryReference(info(), base, (async () => new Response('', { status: 503 })) as typeof fetch), error => error instanceof LibraryAccessError && error.kind === 'unavailable' && error.status === 503);
});

test('cancelled workspace metadata requests preserve the abort instead of claiming a disconnected service', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pinLibraryReference(info(), base, (async () => { throw controller.signal.reason; }) as typeof fetch, controller.signal), error => error === controller.signal.reason);
});
