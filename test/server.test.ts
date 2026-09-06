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
  const root = path.resolve(new URL('../fixtures/video', import.meta.url).pathname);
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

test('log upload accepts shaped documents and rejects garbage', async () => {
  await withFixture(async root => {
    const logsDir = path.join(root, 'logs');
    const server = createMediaServer({ roots: [root], logsDir, onLog: () => {} });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const base = `http://127.0.0.1:${port}`;
      const doc = { schema: 'voidplayer-web-log', version: 1, sessionId: '66c47430-e620-46de-9c72-16833e03adac', events: [] };
      const ok = await fetch(`${base}/api/logs`, { method: 'POST', body: JSON.stringify(doc) });
      assert.equal(ok.status, 201);
      const body = await ok.json();
      assert.match(body.name, /^voidplayer-log-.*-66c47430\.json$/);
      const written = JSON.parse(await fs.readFile(path.join(logsDir, body.name), 'utf8'));
      assert.equal(written.sessionId, doc.sessionId);

      const bad = await fetch(`${base}/api/logs`, { method: 'POST', body: '{"schema":"other"}' });
      assert.equal(bad.status, 400);
      const notJson = await fetch(`${base}/api/logs`, { method: 'POST', body: 'nope' });
      assert.equal(notJson.status, 400);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test('log upload stays disabled without a logs directory', async () => {
  await withFixture(async root => {
    await withServer([root], async base => {
      const res = await fetch(`${base}/api/logs`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 404);
    });
  });
});

test('health, media location, attachment and guarded local reveal share the whitelist', async () => {
  await withFixture(async root => {
    const revealed: string[] = [];
    const server = createMediaServer({ roots: [root], allowLocalReveal: true, reveal: async p => { revealed.push(p); }, onLog: () => {} });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const id = mediaId(root, 'a.mp4');
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.service, 'voidplayer-media'); assert.equal(health.capabilities.reveal, true);
      await fetch(`${base}/api/library`);
      const location = await (await fetch(`${base}/api/media/${id}/location`)).json();
      assert.equal(location.absolutePath, await fs.realpath(path.join(root, 'a.mp4')));
      const attachment = await fetch(`${base}/api/media/${id}?download=1`);
      assert.match(attachment.headers.get('content-disposition')!, /^attachment;/); await attachment.arrayBuffer();
      const url = `${base}/api/media/${id}/reveal`;
      assert.equal((await fetch(url, { method: 'POST' })).status, 403);
      assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://example.com', 'x-voidplayer-action': 'reveal' } })).status, 403);
      assert.equal((await fetch(url, { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'reveal' } })).status, 200);
      assert.deepEqual(revealed, [location.absolutePath]);
      assert.equal((await fetch(`${base}/api/media/${'a'.repeat(24)}/location`)).status, 404);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test('shared media index coalesces scans and revalidates changed or escaped files', async () => {
  await withFixture(async root => {
    let scans = 0, now = 0;
    const { MediaLibraryIndex } = await import('../server/library.ts');
    const index = new MediaLibraryIndex([root], { ttlMs: 1000, now: () => now, scan: async roots => { scans++; return scanLibrary(roots); } });
    const lists = await Promise.all(Array.from({ length: 8 }, () => index.list()));
    assert.equal(scans, 1);
    lists[0].entries[0].name = 'mutated';
    const id = mediaId(root, 'a.mp4');
    await Promise.all(Array.from({ length: 20 }, () => index.resolve(id)));
    assert.equal(scans, 1);
    assert.equal((await index.list()).entries[0].name, 'a.mp4');
    await fs.writeFile(path.join(root, 'new.mp4'), 'new');
    assert.equal((await index.list()).entries.length, 2);
    assert.equal((await index.list(true)).entries.length, 3); assert.equal(scans, 2);
    now = 1001; await Promise.all([index.list(), index.list(), index.resolve(id)]); assert.equal(scans, 3);
    await fs.writeFile(path.join(root, 'a.mp4'), 'changed');
    assert.equal(await index.resolve(id), null);
    await index.list(true); assert.ok(await index.resolve(id));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.mp4'), 'changed');
      await fs.unlink(path.join(root, 'a.mp4')); await fs.symlink(path.join(outside, 'secret.mp4'), path.join(root, 'a.mp4'));
      assert.equal(await index.resolve(id), null);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});

test('Range traffic shares one index and an explicit library refresh discovers additions', async () => {
  await withFixture(async root => {
    let scans = 0;
    const { MediaLibraryIndex } = await import('../server/library.ts');
    const library = new MediaLibraryIndex([root], { scan: async roots => { scans++; return scanLibrary(roots); } });
    const server = createMediaServer({ roots: [root], library, onLog: () => {} });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/api/ready`)).status, 503);
      await fetch(`${base}/api/library`);
      assert.equal((await fetch(`${base}/api/ready`)).status, 200);
      for (let i = 0; i < 12; i++) {
        const response = await fetch(`${base}/api/media/${mediaId(root, 'a.mp4')}`, { headers: { range: `bytes=${i}-${i + 5}` } });
        assert.equal(response.status, 206); await response.arrayBuffer();
      }
      assert.equal(scans, 1);
      await fs.writeFile(path.join(root, 'new.mp4'), 'new');
      assert.equal((await (await fetch(`${base}/api/library?refresh=1`)).json()).entries.length, 3);
      assert.equal(scans, 2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test('gateway identity requires a secret and audit records the authenticated actor, never the secret', async () => {
  await withFixture(async root => {
    const token = 'a'.repeat(64), audit: Record<string, unknown>[] = [];
    const server = createMediaServer({ roots: [root], proxyToken: token, onLog: entry => audit.push(entry) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const headers = { 'x-voidplayer-proxy-token': token, 'x-voidplayer-user': 'tester.one' };
    try {
      assert.equal((await fetch(`${base}/api/library`)).status, 401);
      assert.equal((await fetch(`${base}/api/library`, { headers: { 'x-voidplayer-user': 'forged' } })).status, 401);
      assert.equal((await fetch(`${base}/api/library`, { headers: { ...headers, 'x-voidplayer-proxy-token': 'wrong' } })).status, 401);
      assert.equal((await fetch(`${base}/api/library`, { headers })).status, 200);
      assert.deepEqual((await (await fetch(`${base}/api/health`, { headers })).json()).actor, { id: 'tester.one', name: 'tester.one' });
      assert.equal((await (await fetch(`${base}/api/health`)).json()).actor, null);
      const range = await fetch(`${base}/api/media/${mediaId(root, 'a.mp4')}`, { headers: { ...headers, range: 'bytes=0-9' } });
      await range.arrayBuffer();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(audit.some(e => e.actorId === 'tester.one' && e.status === 206 && e.completed === true));
      assert.ok(!JSON.stringify(audit).includes(token));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});


test('paginated browse, versioned media and guarded scan controls use the shared index', async () => {
  await withFixture(async root => {
    const { MediaLibraryIndex } = await import('../server/library.ts');
    const library = new MediaLibraryIndex([{ id: 'archive', path: root }]); await library.refresh();
    const server = createMediaServer({ roots: library.roots, library, onLog: () => {} });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
      const page = await (await fetch(base + '/api/library/browse?root=archive&limit=1')).json();
      assert.equal(page.entries.length, 1); assert.equal(page.directories[0].name, 'sub');
      const entry = page.entries[0];
      const pinned = `${base}/api/media/${entry.id}?v=${entry.version}`;
      assert.equal((await fetch(pinned, { method: 'HEAD' })).status, 200);
      await fs.writeFile(path.join(root, 'a.mp4'), 'changed'); await library.refresh();
      assert.equal((await fetch(pinned)).status, 409);
      assert.equal((await fetch(`${base}/api/media/${mediaId(root, 'a.mp4')}`, { method: 'HEAD' })).status, 200, 'legacy workspace aliases still resolve');
      assert.equal((await fetch(base + '/api/library/browse?offset=-1')).status, 400);
      assert.equal((await fetch(base + '/api/library/browse?directory=../')).status, 400);
      const action = base + '/api/library/scan';
      assert.equal((await fetch(action, { method: 'POST' })).status, 403);
      assert.equal((await fetch(action, { method: 'POST', headers: { origin: 'https://elsewhere.example', 'x-voidplayer-action': 'scan' } })).status, 403);
      assert.equal((await fetch(action, { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'scan' } })).status, 202);
      await library.refresh();
      const status = await (await fetch(action)).json(); assert.equal(status.job.state, 'completed');
    } finally { await new Promise<void>(r => server.close(() => r())); await library.close(); }
  });
});
