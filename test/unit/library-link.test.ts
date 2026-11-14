import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUriState } from '../../server/uri-state.ts';
import { libraryLocationExpression, libraryLocationLink, parseLibraryLocationInput, parseLibraryLocationLink } from '../../src/ui/library-link.ts';

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
  assert.equal(new URL(link).searchParams.get('library'),'archive');
  assert.equal(new URL(link).searchParams.has('root'),false);
  assert.deepEqual(parseLibraryLocationLink(link, 'https://review.example/'), location);
  assert.deepEqual(parseLibraryLocationInput(link, 'https://review.example/'), location);
  assert.equal(new URL(link).searchParams.has('share'), false);
});

test('media library links reject other services and unsafe directory paths', () => {
  assert.throws(() => parseLibraryLocationLink('https://other.example/?library=1', 'https://review.example/'), /另一个媒体服务/);
  assert.throws(() => parseLibraryLocationLink('https://review.example/?library=1&root=archive&dir=..%2Fprivate', 'https://review.example/'), /目录无效/);
});

test('explicit library file links use the share ABI and preserve the pinned version and directory', async () => {
  const { libraryFileLink } = await import('../../src/ui/library-link.ts');
  const entry = {id:'a'.repeat(24),version:'b'.repeat(24),name:'实验一/镜头 A/片段.mp4',root:'Archive',rootId:'archive',size:12,lastModified:1};
  const link = new URL(libraryFileLink(entry, 'https://review.example/admin#library'));
  assert.deepEqual([...link.searchParams.keys()], ['s']);
  const state = decodeUriState(link.searchParams.get('s')!);
  assert.deepEqual(state.tracks, [{ slot: 'A', id: entry.id, version: entry.version, offsetUs: 0, visible: true }]);
  assert.deepEqual(state.layout?.sources, { root: 'archive', directory: '实验一/镜头 A', all: false, tab: 'available', query: '', search: '' });
  assert.equal(state.layout?.panels.sources, true);
});

test('canonical library scopes and legacy links restore the same location', () => {
  const base='https://review.example/';
  for (const [location,scope,legacy] of [
    [{root:'',directory:'',all:false},'','?library=1'],
    [{root:'',directory:'',all:true},'*','?library=1&all=1'],
    [{root:'archive',directory:'镜头 A',all:false},'archive','?library=1&root=archive&dir=镜头%20A'],
  ] as const) {
    const link=libraryLocationLink(location,base), url=new URL(link);
    assert.equal(url.searchParams.get('library'),scope);
    assert.equal(url.searchParams.has('root')||url.searchParams.has('all'),false);
    assert.deepEqual(parseLibraryLocationLink(link,base),location);
    assert.deepEqual(parseLibraryLocationLink(new URL(legacy,base).href,base),location);
  }
  const numeric={root:'1',directory:'',all:false};
  assert.deepEqual(parseLibraryLocationLink(libraryLocationLink(numeric,base),base),numeric,'legacy switch value remains an unambiguous configured root');
  assert.deepEqual(parseLibraryLocationLink(base+'?library=archive&root=other&all=1',base),{root:'archive',directory:'',all:false});
  assert.throws(() => parseLibraryLocationLink(base+'?library=archive/../other',base),/标识无效/);
});
