import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediaId, resolveMediaPath, scanLibrary } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';
import { Input, UrlSource, ALL_FORMATS } from 'mediabunny';
import { inspectVideoTrack } from '../src/media.ts';

async function withFixture(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-lib-'));
  try {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.mp4'), Buffer.alloc(1000, 1));
    await fs.writeFile(path.join(root, 'sub', 'b.mkv'), Buffer.alloc(500, 2));
    await fs.writeFile(path.join(root, 'notes.txt'), 'not media');
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.writeFile(path.join(root, '.hidden', 'c.mp4'), Buffer.alloc(10, 3));
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withServer(roots: string[], fn: (base: string) => Promise<void>) {
  const server = createMediaServer({ roots, onLog: () => {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('library scan lists whitelisted media with stable ids, skipping hidden and non-media files', async () => {
  await withFixture(async root => {
    const library = await scanLibrary([root]);
    assert.deepEqual(library.entries.map(e => e.name), ['a.mp4', 'sub/b.mkv']);
    assert.equal(library.truncated, false);
    assert.equal(library.entries[0].id, mediaId(root, 'a.mp4'));
  });
});

test('media id resolution refuses unknown, malformed and traversal-shaped ids', async () => {
  await withFixture(async root => {
    const library = await scanLibrary([root]);
    const id = library.entries.find(e => e.name === 'sub/b.mkv')!.id;
    assert.equal(await resolveMediaPath([root], id), await fs.realpath(path.join(root, 'sub', 'b.mkv')));
    assert.equal(await resolveMediaPath([root], 'not-an-id'), null);
    assert.equal(await resolveMediaPath([root], 'a'.repeat(24)), null);
    assert.equal(await resolveMediaPath([root], mediaId(root, '../../etc/passwd')), null);
  });
});

test('media endpoint serves full, ranged and suffix requests with correct semantics', async () => {
  await withFixture(async root => {
    const id = mediaId(root, 'a.mp4');
    await withServer([root], async base => {
      const library = await (await fetch(`${base}/api/library`)).json();
      assert.equal(library.entries.length, 2);

      const full = await fetch(`${base}/api/media/${id}`);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-length'), '1000');
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal((await full.arrayBuffer()).byteLength, 1000);

      const ranged = await fetch(`${base}/api/media/${id}`, { headers: { range: 'bytes=100-199' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/1000');
      assert.equal((await ranged.arrayBuffer()).byteLength, 100);

      const suffix = await fetch(`${base}/api/media/${id}`, { headers: { range: 'bytes=-10' } });
      assert.equal(suffix.status, 206);
      assert.equal(suffix.headers.get('content-range'), 'bytes 990-999/1000');

      const bad = await fetch(`${base}/api/media/${id}`, { headers: { range: 'bytes=2000-' } });
      assert.equal(bad.status, 416);

      const head = await fetch(`${base}/api/media/${id}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), '1000');

      const missing = await fetch(`${base}/api/media/${'b'.repeat(24)}`);
      assert.equal(missing.status, 404);

      const write = await fetch(`${base}/api/media/${id}`, { method: 'POST' });
      assert.equal(write.status, 405);
    });
  });
});

test('mediabunny streams a library item over HTTP range requests', async () => {
  const root = path.resolve(new URL('../../resources/video', import.meta.url).pathname);
  await withServer([root], async base => {
    const library = await (await fetch(`${base}/api/library`)).json();
    const entry = library.entries.find((e: { name: string }) => e.name === 'h264_9s_1920x1080.mp4');
    assert.ok(entry, 'sample present in library');
    const input = new Input({ source: new UrlSource(`${base}/api/media/${entry.id}`), formats: ALL_FORMATS });
    try {
      const { codec, format } = await inspectVideoTrack(input);
      assert.equal(format, 'MP4');
      assert.match(codec, /^avc1\./);
    } finally { input.dispose(); }
  });
});
