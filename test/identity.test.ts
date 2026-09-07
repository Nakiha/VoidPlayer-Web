import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../server/workspaces.ts';
import { openIndexDatabase } from '../server/sqlite.ts';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';

test('user IDs survive rename, existing names switch without merging, normalized names stay unique', () => {
  const store = new WorkspaceStore(':memory:');
  try {
    const a = store.identify(), b = store.identify();
    assert.notEqual(a.id, b.id); assert.notEqual(a.name, b.name);
    const named = store.identify(a.id, '  测试用户  ');
    assert.equal(named.id, a.id); assert.equal(named.name, '测试用户');
    assert.deepEqual(store.identify(b.id, '测试用户'), named);
    assert.deepEqual(store.user(b.id), b);
    const unicode = store.identify(b.id, 'e\u0301');
    assert.deepEqual(store.identify(undefined, 'é'), unicode);
    assert.equal(store.users().length, 2);
    for (const value of ['', '  ', '\u0000', 'a\nb', '\u202e', 'a'.repeat(129), 42, null]) assert.throws(() => store.identify(a.id, value));
    assert.deepEqual(store.user(a.id), named);
  } finally { store.close(); }
});

test('legacy owners migrate without changing IDs and new identities survive restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-users-'));
  const file = path.join(root, 'workspaces.sqlite');
  try {
    let store = new WorkspaceStore(file); store.close();
    const db = openIndexDatabase(file);
    db.exec("DROP TABLE users; PRAGMA user_version=1; INSERT INTO workspaces VALUES('legacy','review','local','now','now','local',1,2,0,0,'{}')"); db.close();
    store = new WorkspaceStore(file);
    assert.deepEqual(store.user('local'), { id: 'local', name: 'local' });
    const named = store.identify('local', '原来的用户'); const other = store.identify(); store.close();
    store = new WorkspaceStore(file);
    assert.deepEqual(store.user(named.id), named); assert.deepEqual(store.user(other.id), other);
    assert.equal(store.list(named, false).entries[0].owner, 'local'); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('intranet HTTP auto-creates cookie identity, lists users and atomically resolves competing name claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-identity-http-'));
  await mkdir(path.join(root, 'media'));
  const config = await loadConfig(['--folder', 'media', '--host', '0.0.0.0'], 'production', root); config.port = 0; config.logsDir = null;
  const service = await startService(config, false);
  const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const identify = (cookie: string, name: unknown, origin = base) => fetch(base + '/api/identity', { method: 'POST', headers: { cookie, origin, 'x-voidplayer-action': 'identity', 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  try {
    const response = await fetch(base + '/api/health'); const a = (await response.json()).actor;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    assert.ok(cookie.includes(a.id)); assert.match(response.headers.get('set-cookie')!, /Max-Age=/);
    assert.deepEqual((await (await fetch(base + '/api/health', { headers: { cookie } })).json()).actor, a);
    const named = await identify(cookie, '小明'); assert.equal(named.status, 200); assert.equal((await named.json()).actor.id, a.id);
    const contenders = await Promise.all(Array.from({ length: 12 }, () => identify('', '共同用户').then(r => r.json())));
    assert.equal(new Set(contenders.map(r => r.actor.id)).size, 1);
    const selected = await identify(cookie, '共同用户'); const next = (await selected.json()).actor;
    assert.notEqual(next.id, a.id); assert.ok(selected.headers.get('set-cookie')!.includes(next.id));
    const users = (await (await fetch(base + '/api/users')).json()).users;
    assert.equal(users.length, 2); assert.ok(users.some((u: { name: string }) => u.name === '小明'));
    const byId = await fetch(base + '/api/identity', { method: 'POST', headers: { cookie, origin: base, 'x-voidplayer-action': 'identity', 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }) });
    assert.equal(byId.status, 200); assert.equal((await byId.json()).actor.name, '小明');
    assert.equal((await identify(cookie, '')).status, 400);
    assert.equal((await identify(cookie, 'bad', 'https://other.test')).status, 403);
    assert.equal((await fetch(base + '/api/workspaces', { headers: { cookie, 'x-voidplayer-actor': next.id } })).status, 409);
    assert.equal((await fetch(base + '/api/library')).status, 200);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
