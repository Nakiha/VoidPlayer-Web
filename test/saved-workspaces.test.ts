import { httpFetch as fetch } from './http-request.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { WorkspaceStore, WORKSPACE_BYTES } from '../server/workspaces.ts';
import { openIndexDatabase } from '../server/sqlite.ts';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { Viewport } from '../src/viewport.ts';
import { parseWorkspace } from '../src/workspace-file.ts';
const alice = { id: 'alice', name: 'Alice' }, bob = { id: 'bob', name: 'Bob' };
const document = () => parseWorkspace({ schema: 'voidplayer-workspace', version: 1, generatedAt: new Date().toISOString(), serverUrl: 'http://example.test/', positionUs: 200, tracks: [{ slot: 'A', mediaId: 'sample', offsetUs: 0 }], media: [{ id: 'sample', name: 'sample.mp4', size: 100, lastModified: 10, codec: 'h264', decoder: 'webcodecs', width: 100, height: 100, durationUs: 1000, firstPtsUs: 0 }], marks: [], viewport: new Viewport().snapshot(), layout: { panels: { inspector: true, subtracks: true, sources: true }, selected: 'A', dockHeight: 260, marksExpanded: true } });
async function temporary(run: (root: string) => Promise<void>) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-workspaces-')); try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } }

test('workspace transactions persist metadata, content and ownership across close and backup restore', () => temporary(async root => {
  const file = path.join(root, 'data', 'workspaces.sqlite'), store = new WorkspaceStore(file), input = document();
  const created = store.create({ name: '  评审一  ', document: input, owner: 'forged' }, alice); assert.equal(created.owner, alice.id); assert.equal(created.name, '评审一'); assert.equal(created.revision, 1);
  const updated = store.update(created.id, '"1"', { name: '评审二', document: { ...input, positionUs: 600 } }, bob, true);
  assert.equal(updated.owner, alice.id); assert.equal(updated.updatedBy, bob.id); assert.equal(updated.revision, 2);
  store.close(); await fs.cp(path.join(root, 'data'), path.join(root, 'backup'), { recursive: true });
  const restored = new WorkspaceStore(path.join(root, 'backup', 'workspaces.sqlite'));
  try { assert.deepEqual(restored.read(created.id, alice), { ...updated, document: { ...input, positionUs: 600 } }); } finally { restored.close(); }
}));

test('updates and deletion require a matching revision and cannot erase newer edits', () => temporary(async root => {
  const file = path.join(root, 'workspaces.sqlite'), a = new WorkspaceStore(file), b = new WorkspaceStore(file);
  try {
    const first = a.create({ name: 'one', document: document() }, alice);
    assert.throws(() => b.update(first.id, undefined, { name: 'invalid', document: document() }, alice), /版本/);
    a.update(first.id, '"1"', { name: 'newer', document: document() }, alice);
    assert.throws(() => b.update(first.id, '"1"', { name: 'stale', document: document() }, alice), /已更新/);
    assert.throws(() => b.remove(first.id, '"1"', alice), /已更新/);
    assert.equal(a.read(first.id, alice).name, 'newer');
    b.remove(first.id, '"2"', alice); assert.throws(() => a.read(first.id, alice), /不存在/);
    assert.throws(() => a.update(first.id, '"2"', { name: 'revive', document: document() }, alice), /不存在/);
  } finally { b.close(); a.close(); }
}));

test('stored workspaces use the shared format validator and refuse unsupported databases', () => temporary(async root => {
  const file = path.join(root, 'workspaces.sqlite'), store = new WorkspaceStore(file);
  try {
    for (const input of [{ name: '', document: document() }, { name: 'invalid', document: { ...document(), version: 20 } }, { name: 'invalid', document: { ...document(), serverUrl: 'file:///tmp' } }, { name: 'invalid', document: { ...document(), tracks: [{ slot: 'A', mediaId: 'missing', offsetUs: 0 }] } }]) assert.throws(() => store.create(input, alice));
    assert.equal(store.list(alice, false).entries.length, 0);
  } finally { store.close(); }
  const db = openIndexDatabase(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new WorkspaceStore(file), /更新的程序/);
  const retained = openIndexDatabase(file); assert.equal((retained.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99); retained.close();
}));

test('workspace listing is bounded, omits documents, and isolates owners', () => temporary(async root => {
  const store = new WorkspaceStore(path.join(root, 'workspaces.sqlite'));
  try {
    for (let i = 0; i < 85; i++) store.create({ name: `review-${i}`, document: document() }, i % 2 ? alice : bob);
    const ids = new Set<string>(); let before = '';
    do { const page = store.list(alice, true, before); assert.ok(page.entries.length <= 40); for (const row of page.entries) { assert.ok(!('document' in row)); assert.ok(!ids.has(row.id)); ids.add(row.id); } before = page.next ?? ''; } while (before);
    assert.equal(ids.size, 85); assert.ok(store.list(alice, false).entries.every(row => row.owner === 'alice'));
    assert.equal(store.list(alice, true, '', 'review-84').entries.length, 1);
    const privateRow = store.list(bob, false).entries[0]; assert.throws(() => store.read(privateRow.id, alice), /无权/); assert.throws(() => store.remove(privateRow.id, '"1"', alice), /无权/);
  } finally { store.close(); }
}));

test('HTTP workspace access uses trusted ownership, same-origin writes and atomic competing updates', () => temporary(async root => {
  await fs.mkdir(path.join(root, 'media')); await fs.writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: ['media'], dataDir: 'data', logsDir: null, adminUsers: ['admin'], indexWatch: false }));
  const config = await loadConfig([], 'production', root); config.port = 0;
  const service = await startService(config, false); const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const actors: Record<string, { id: string; name: string }> = {};
  for (const name of ['alice', 'bob', 'admin']) { const response = await fetch(base + '/api/identity', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-voidplayer-action': 'identity' }, body: JSON.stringify({ name }) }); actors[name] = (await response.json()).actor; }
  const call = (url: string, user = 'alice', method = 'GET', body?: unknown, revision?: string) => fetch(base + url, { method, headers: { origin: 'http://intranet.test', host: 'intranet.test', 'x-voidplayer-action': 'workspace', 'content-type': 'application/json', cookie: `voidplayer-user=${actors[user].id}`, ...(revision ? { 'if-match': revision } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const created = await call('/api/workspaces', 'alice', 'POST', { name: 'private', document: document(), owner: 'admin' }); assert.equal(created.status, 201); const entry = await created.json();
    assert.equal(entry.owner, actors.alice.id); assert.equal((await call('/api/workspaces/' + entry.id, 'bob')).status, 404);
    assert.equal((await call('/api/workspaces?all=1', 'bob')).status, 403); assert.equal((await call('/api/workspaces?all=1', 'admin')).status, 200);
    assert.equal((await fetch(base + '/api/workspaces', { headers: { 'x-voidplayer-user': 'admin' } })).status, 403);
    assert.equal((await fetch(base + '/api/workspaces', { method: 'POST', headers: { cookie: `voidplayer-user=${actors.alice.id}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'cross-origin', document: document() }) })).status, 403);
    const updates = await Promise.all(['a', 'b'].map(name => call('/api/workspaces/' + entry.id, 'alice', 'PUT', { name, document: document() }, '"1"')));
    assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
    const result = await call('/api/workspaces/' + entry.id, 'admin'); assert.equal(result.headers.get('etag'), '"2"');
    const doc = await result.json(); assert.equal(doc.revision, 2); assert.equal(doc.owner, actors.alice.id);
    assert.equal((await call('/api/workspaces/' + entry.id, 'admin', 'DELETE', undefined, '"1"')).status, 409);
    const big = await new Promise<number>((resolve, reject) => { const req = request(base + '/api/workspaces', { method: 'POST', headers: { origin: 'http://intranet.test', host: 'intranet.test', 'x-voidplayer-action': 'workspace', cookie: `voidplayer-user=${actors.alice.id}`, 'content-type': 'application/json', 'content-length': WORKSPACE_BYTES + 4096 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.on('error', reject); req.end(); });
    assert.equal(big, 413);
  } finally { await service.close(); }
}));


test('a rejected SQLite write leaves workspace content and revision unchanged', () => temporary(async root => {
  const file = path.join(root, 'workspaces.sqlite'), store = new WorkspaceStore(file);
  try {
    const created = store.create({ name: 'before', document: document() }, alice), before = store.read(created.id, alice);
    const connection = openIndexDatabase(file);
    try { connection.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;"); } finally { connection.close(); }
    assert.throws(() => store.update(created.id, '"1"', { name: 'after', document: { ...document(), positionUs: 900 } }, alice), /storage unavailable/);
    assert.deepEqual(store.read(created.id, alice), before);
  } finally { store.close(); }
}));
