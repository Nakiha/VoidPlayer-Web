import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { loadConfig } from '../server/config.ts';
import { MediaLibraryIndex } from '../server/library.ts';
import { AdminController } from '../server/admin.ts';
import { createMediaServer } from '../server/app.ts';

type Fixture = { root: string; media: string; base: string; library: MediaLibraryIndex; admin: AdminController; config: Awaited<ReturnType<typeof loadConfig>> };
async function fixture(run: (f: Fixture) => Promise<void>, token?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-admin-'));
  const media = path.join(root, 'media'); await fs.mkdir(media); await fs.writeFile(path.join(media, 'one.mp4'), 'video');
  await fs.writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: [{ id: 'archive', path: 'media', name: '媒体库' }], dataDir: 'data', logsDir: 'logs', adminUsers: ['owner'], indexWatch: false }));
  const config = await loadConfig([], 'production', root); await fs.mkdir(config.dataDir);
  const library = new MediaLibraryIndex(config.mediaRoots, { database: path.join(config.dataDir, 'library.sqlite'), watch: false });
  library.start(); await library.refresh();
  const admin = new AdminController(config, library, { version: 'test-version', revision: 'test-revision' });
  const server = createMediaServer({ roots: library.roots, library, admin, logsDir: config.logsDir!, proxyToken: token, onLog: () => {} });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { await run({ root, media, base, library, admin, config }); }
  finally { await new Promise<void>(r => server.close(() => r())); await admin.close(); await library.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const mutation = (base: string, method: string, value?: unknown, extra = {}) => ({ method, headers: { origin: base, 'content-type': 'application/json', 'x-voidplayer-action': 'admin', ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });

test('admin requires a loopback host or an allowlisted trusted gateway identity', async () => {
  await fixture(async ({ base }) => {
    const status = await (await fetch(base + '/api/admin/status')).json();
    assert.equal(status.identity.id, 'local'); assert.equal(status.version, 'test-version'); assert.ok(status.memory.rss > 0); assert.ok(status.http.connections > 0);
    const rebound = await new Promise<number>(resolve => { const req = request(base + '/api/admin/status', { headers: { host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end(); });
    assert.equal(rebound, 403);
    assert.equal((await fetch(base + '/api/admin/scan', mutation('https://attacker.example', 'POST', { action: 'cancel' }))).status, 403);
    assert.equal((await fetch(base + '/api/admin/scan', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  });
  const token = 'a'.repeat(64);
  await fixture(async ({ base }) => {
    assert.equal((await fetch(base + '/api/admin/status', { headers: { 'x-voidplayer-user': 'owner' } })).status, 403);
    assert.equal((await fetch(base + '/api/admin/status', { headers: { 'x-voidplayer-user': 'viewer', 'x-voidplayer-proxy-token': token } })).status, 403);
    const headers = { 'x-voidplayer-user': 'owner', 'x-voidplayer-proxy-token': token, 'x-forwarded-proto': 'https' };
    const response = await fetch(base + '/api/admin/status', { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).identity.id, 'owner');
    assert.equal((await fetch(base + '/api/admin/scan', mutation(base, 'POST', { action: 'cancel' }, headers))).status, 403, 'protocol mismatch cannot authorize writes');
    assert.equal((await fetch(base + '/api/admin/scan', mutation(base.replace('http:', 'https:'), 'POST', { action: 'cancel' }, headers))).status, 202);
  }, token);
});

test('root edits persist stable identities, preserve unrelated config and reject stale or external edits', async () => fixture(async ({ root, media, base, library, config }) => {
  const original = library.browse().entries[0];
  const before = await (await fetch(base + '/api/admin/roots')).json();
  const moved = path.join(root, 'moved'); await fs.rename(media, moved);
  const roots = [{ ...before.roots[0], name: '移动后的媒体', path: moved }];
  const saved = await fetch(base + '/api/admin/roots', mutation(base, 'PUT', { revision: before.revision, roots }));
  assert.equal(saved.status, 200); const after = await saved.json(); assert.notEqual(after.revision, before.revision);
  await library.refresh(); assert.equal(library.browse().entries[0].id, original.id); assert.ok(await library.resolve(original.id));
  const loaded = await loadConfig([], 'production', root); assert.deepEqual(loaded.mediaRoots, roots); assert.deepEqual(loaded.adminUsers, ['owner']); assert.equal(loaded.indexWatch, false);
  const stale = await fetch(base + '/api/admin/roots', mutation(base, 'PUT', { revision: before.revision, roots })); assert.equal(stale.status, 409);
  await fs.writeFile(config.origin!.file, JSON.stringify({ mediaRoots: roots, adminUsers: ['new-owner'] }));
  assert.equal((await (await fetch(base + '/api/admin/roots')).json()).writable, false);
  const external = await fetch(base + '/api/admin/roots', mutation(base, 'PUT', { revision: after.revision, roots })); assert.equal(external.status, 409);
  assert.deepEqual(JSON.parse(await fs.readFile(config.origin!.file, 'utf8')).adminUsers, ['new-owner']);
}));

test('invalid roots and failed persistence leave the active index intact', async () => fixture(async ({ base, library, config }) => {
  const before = await (await fetch(base + '/api/admin/roots')).json();
  const file = await fs.readFile(config.origin!.file, 'utf8');
  for (const roots of [[], [{ id: '../bad', name: 'bad', path: '/media' }], [before.roots[0], before.roots[0]], [{ ...before.roots[0], path: 'relative' }]]) {
    assert.equal((await fetch(base + '/api/admin/roots', mutation(base, 'PUT', { revision: before.revision, roots }))).status, 400);
  }
  await assert.rejects(library.reconfigure([{ id: 'other', path: '/other' }], async () => { throw new Error('write failure'); }), /write failure/);
  await library.refresh(); assert.equal(library.browse().total, 1); assert.equal(library.definitions[0].id, 'archive');
  assert.equal(await fs.readFile(config.origin!.file, 'utf8'), file);
  const oversized = await fetch(base + '/api/admin/roots', mutation(base, 'PUT', { padding: 'x'.repeat(70000) })); assert.equal(oversized.status, 413);
}));

test('uploaded logs get server-authored receipts and version-checked read/delete operations', async () => fixture(async ({ base, config }) => {
  const doc = { schema: 'voidplayer-web-log', sessionId: 'test-session', events: [], serverReceipt: { id: 'forged', actorId: 'fake-admin' } };
  const upload = await fetch(base + '/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  assert.equal(upload.status, 201); const { name } = await upload.json();
  const listing = await (await fetch(base + '/api/admin/logs')).json(); assert.equal(listing.entries.length, 1);
  const entry = listing.entries[0];
  const detail = await (await fetch(`${base}/api/admin/logs/${name}?v=${entry.version}`)).json();
  assert.equal(detail.document.serverReceipt.actorId, 'local'); assert.notEqual(detail.document.serverReceipt.id, 'forged'); assert.ok(name.includes(detail.document.serverReceipt.id));
  assert.equal((await fetch(`${base}/api/admin/logs/${name}`, mutation(base, 'DELETE'))).status, 428);
  await fs.writeFile(path.join(config.logsDir!, name), JSON.stringify({ ...detail.document, changed: true }));
  assert.equal((await fetch(`${base}/api/admin/logs/${name}?v=${entry.version}`)).status, 409);
  assert.equal((await fetch(`${base}/api/admin/logs/${name}`, mutation(base, 'DELETE', undefined, { 'if-match': `"${entry.version}"` }))).status, 409);
  const current = (await (await fetch(base + '/api/admin/logs')).json()).entries[0];
  assert.equal((await fetch(`${base}/api/admin/logs/${name}`, mutation(base, 'DELETE', undefined, { 'if-match': `"${current.version}"` }))).status, 200);
  assert.equal((await (await fetch(base + '/api/admin/logs')).json()).entries.length, 0);
}));

test('log pagination stays bounded and symlinks never grant access outside the log directory', async () => fixture(async ({ root, base, config }) => {
  await fs.mkdir(config.logsDir!, { recursive: true });
  for (let i = 0; i < 85; i++) await fs.writeFile(path.join(config.logsDir!, `voidplayer-log-${String(i).padStart(4, '0')}.json`), '{}');
  let cursor = ''; const names = new Set<string>();
  do {
    const page = await (await fetch(base + '/api/admin/logs?before=' + cursor)).json(); assert.ok(page.entries.length <= 40);
    for (const entry of page.entries) { assert.ok(!names.has(entry.name)); names.add(entry.name); } cursor = page.next;
  } while (cursor);
  assert.equal(names.size, 85);
  const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, '{"private":true}');
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(config.logsDir!, 'voidplayer-log-link.json'));
    assert.equal((await fetch(base + '/api/admin/logs/voidplayer-log-link.json')).status, 404);
  }
  assert.equal((await fetch(base + '/api/admin/logs/..%2Foutside.json')).status, 404);
}));
