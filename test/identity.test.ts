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
    const a = store.identify(undefined, '甲'), b = store.identify(undefined, '乙');
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

test('explicit rename and create never switch or rename another identity', () => {
  const store = new WorkspaceStore(':memory:');
  try {
    const a = store.identify(undefined, '甲'), b = store.identify(undefined, '乙');
    assert.throws(() => store.identify(a.id, '乙', 'rename'), /已被使用/);
    assert.deepEqual(store.user(a.id), a); assert.deepEqual(store.user(b.id), b);
    assert.throws(() => store.identify(a.id, '乙', 'create'), /已被使用/);
    const c = store.identify(a.id, '丙', 'create');
    assert.notEqual(c.id, a.id); assert.deepEqual(store.user(a.id), a);
    assert.equal(store.identify(a.id, '改名', 'rename').id, a.id);
    assert.throws(() => store.identify(undefined, '新名字', 'rename'), /先选择/);
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
    const named = store.identify('local', '原来的用户'); const other = store.identify(undefined, '另一用户'); store.close();
    store = new WorkspaceStore(file);
    assert.deepEqual(store.user(named.id), named); assert.deepEqual(store.user(other.id), other);
    assert.equal(store.list(named, false).entries[0].owner, 'local'); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('intranet HTTP explicitly chooses cookie identity, lists users and atomically resolves competing name claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-identity-http-'));
  await mkdir(path.join(root, 'media'));
  const config = await loadConfig(['--folder', 'media', '--host', '0.0.0.0'], 'production', root); config.port = 0; config.logsDir = null;
  const service = await startService(config, false);
  const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const identify = (cookie: string, name: unknown, origin = base) => fetch(base + '/api/identity', { method: 'POST', headers: { cookie, origin, 'x-voidplayer-action': 'identity', 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  try {
    for (let i=0;i<5;i++) {
      const response = await fetch(base + '/api/health');
      assert.equal((await response.json()).actor, null); assert.equal(response.headers.get('set-cookie'), null);
    }
    for (const route of ['/api/workspaces', '/api/annotations/spaces', '/api/admin/status']) {
      const response = await fetch(base+route); assert.equal(response.status,200); assert.equal(response.headers.get('set-cookie'),null);
    }
    assert.deepEqual((await (await fetch(base+'/api/users')).json()).users,[]);
    const guestResponse = await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({guest:true})});
    const guest=(await guestResponse.json()).actor, guestCookie=guestResponse.headers.get('set-cookie')!.split(';')[0];
    assert.equal(guest.kind,'guest');
    assert.deepEqual((await (await fetch(base+'/api/health',{headers:{cookie:guestCookie}})).json()).actor,guest);
    assert.deepEqual((await (await fetch(base+'/api/users')).json()).users,[]);
    const response = await identify('', '小明'); const a = (await response.json()).actor;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const downgrade = await fetch(base+'/api/identity', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-voidplayer-action': 'identity' }, body: JSON.stringify({ guest: true }) });
    assert.equal(downgrade.status, 409); assert.equal(downgrade.headers.get('set-cookie'), null);
    assert.ok(cookie.includes(a.id)); assert.match(response.headers.get('set-cookie')!, /Max-Age=/);
    assert.deepEqual((await (await fetch(base + '/api/health', { headers: { cookie } })).json()).actor, a);
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

test('legacy generated users become visitors without deleting attribution; guest cookies never create rows', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vp-legacy-identity-')),file=path.join(root,'workspaces.sqlite');
  try {
    const db=openIndexDatabase(file);
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE); INSERT INTO users VALUES('old','用户-1234abcd'); PRAGMA user_version=2;"); db.close();
    let store=new WorkspaceStore(file);
    assert.deepEqual(store.users(),[]); assert.deepEqual(store.user('old'),{id:'old',name:'访客',kind:'guest'});
    assert.throws(()=>store.identify(),/填写用户名/);
    const named=store.identify('old','明确命名'); assert.equal(named.id,'old'); assert.deepEqual(store.users(),[named]);
    store.close();store=new WorkspaceStore(file);assert.deepEqual(store.users(),[named]);store.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
