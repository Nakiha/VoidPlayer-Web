import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryLocationExpression, libraryLocationLink, parseLibraryLocationInput, parseLibraryLocationLink } from '../src/ui/library-link.ts';

test('media library expressions are compact, copyable, and service-relative', () => {
  const base = 'https://review.example/';
  const scoped = { root: 'archive', directory: '实验一/镜头 A', all: false };
  assert.equal(libraryLocationExpression(scoped), 'library:archive/实验一/镜头 A');
  assert.deepEqual(parseLibraryLocationInput(libraryLocationExpression(scoped), base), scoped);
  assert.equal(libraryLocationExpression({ root: '', directory: '', all: false }), 'library:/');
  assert.equal(libraryLocationExpression({ root: '', directory: '', all: true }), 'library:*');
  assert.deepEqual(parseLibraryLocationInput('library:*', base), { root: '', directory: '', all: true });
  assert.throws(() => parseLibraryLocationInput('library:archive/../private', base), /目录无效/);
});

test('media library links preserve root IDs and nested Unicode directories', () => {
  const location = { root: 'archive', directory: '实验一/镜头 A', all: false };
  const link = libraryLocationLink(location, 'https://review.example/?share=old');
  assert.deepEqual(parseLibraryLocationLink(link, 'https://review.example/'), location);
  assert.deepEqual(parseLibraryLocationInput(link, 'https://review.example/'), location);
  assert.equal(new URL(link).searchParams.has('share'), false);
});

test('media library links reject other services and unsafe directory paths', () => {
  assert.throws(() => parseLibraryLocationLink('https://other.example/?library=1', 'https://review.example/'), /另一个媒体服务/);
  assert.throws(() => parseLibraryLocationLink('https://review.example/?library=1&root=archive&dir=..%2Fprivate', 'https://review.example/'), /目录无效/);
});
