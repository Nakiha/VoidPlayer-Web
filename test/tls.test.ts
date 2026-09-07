import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { prepareTls, parseTls } from '../server/tls.ts';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { httpFetch } from './http-request.ts';

test('portable CA persists across restarts/moves and reissues for changed LAN addresses', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vp-tls-'));
  try {
    const dir = path.join(temp, 'data');
    const tls = await prepareTls({ hosts: ['192.168.1.8', 'voidplayer.test'] }, dir);
    const ca = new X509Certificate(tls.ca!);
    const leaf = new X509Certificate(tls.cert);
    assert.ok(ca.ca && leaf.verify(ca.publicKey)); assert.ok(leaf.checkIP('192.168.1.8')); assert.ok(leaf.checkHost('voidplayer.test'));
    assert.ok(leaf.checkIP('::1')); assert.ok(!leaf.ca);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'tls/authority.json'))).mode & 0o777, 0o600);
    assert.equal((await prepareTls({ hosts: ['192.168.1.8', 'voidplayer.test'] }, dir)).cert, tls.cert);
    await rename(dir, path.join(temp, 'moved'));
    const moved = await prepareTls({ hosts: ['192.168.1.9'] }, path.join(temp, 'moved'));
    assert.equal(moved.ca, tls.ca); assert.notEqual(moved.cert, tls.cert);
    assert.ok(new X509Certificate(moved.cert).checkIP('192.168.1.9'));
    assert.ok(!new X509Certificate(moved.cert).checkIP('192.168.1.8'));
    await writeFile(path.join(temp, 'moved/tls/authority.json'), '{}');
    await assert.rejects(prepareTls({ hosts: ['192.168.1.9'] }, path.join(temp, 'moved')), 'corrupt CA must not be silently replaced');
    for (const value of [{ hosts: ['https://host/'] }, { hosts: ['0.0.0.0'] }, { hosts: [] }, { hosts: ['host'], keyFile: 'key' }, { certFile: 'cert' }]) assert.throws(() => parseTls(value, temp));
    assert.deepEqual(parseTls({ certFile: 'cert.pem', keyFile: 'key.pem' }, temp), { certFile: path.join(temp, 'cert.pem'), keyFile: path.join(temp, 'key.pem') });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('trusted HTTPS serves remote media, isolation headers and identity with same-origin checks', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vp-https-')); let service;
  try {
    await mkdir(path.join(temp, 'media')); await mkdir(path.join(temp, 'dist'));
    await writeFile(path.join(temp, 'dist/index.html'), 'VoidPlayer');
    await writeFile(path.join(temp, 'media/clip.mp4'), '0123456789');
    await utimes(path.join(temp, 'media/clip.mp4'), 1, 1);
    const config = await loadConfig(['--https', 'voidplayer.test', '--folder', path.join(temp, 'media'), '--static', path.join(temp, 'dist'), '--no-logs'], 'production', temp, { dataDir: path.join(temp, 'data') });
    config.host = '127.0.0.1'; config.port = 0;
    service = await startService(config);
    const base = `https://127.0.0.1:${(service.server.address() as { port: number }).port}`;
    const ca = service.tls!.ca!;
    await assert.rejects(httpFetch(base), /certificate|issuer|self.signed/i);
    await assert.rejects(httpFetch(base, { ca, servername: 'wrong.test' }), /altname|altnames|Hostname/i);
    const host = `voidplayer.test:${(service.server.address() as { port: number }).port}`;
    const response = await httpFetch(base + '/api/health', { ca, servername: 'voidplayer.test', headers: { host } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.match(response.headers.get('set-cookie')!, /; Secure/);
    const actor = (await response.json()).actor;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    for (const [origin, expected] of [[`https://${host}`, 200], [`http://${host}`, 403], ['https://other.test', 403]] as const) {
      const change = await httpFetch(base + '/api/identity', { ca, method: 'POST', headers: { host, origin, cookie, 'x-voidplayer-action': 'identity', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HTTPS用户' }) });
      assert.equal(change.status, expected); if (expected === 200) assert.equal((await change.json()).actor.id, actor.id);
    }
    const listing = await service.library.list();
    const range = await httpFetch(`${base}/api/media/${listing.entries[0].id}`, { ca, headers: { range: 'bytes=2-5', host } });
    assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
    assert.equal((await httpFetch(base + '/data/tls/authority.json', { ca })).status, 404);
    assert.ok(await readFile(service.tls!.caFile!, 'utf8'));
  } finally { await service?.close(); await rm(temp, { recursive: true, force: true }); }
});
