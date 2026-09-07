import { httpFetch } from './http-request.ts';
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
const MiB = 1024 * 1024;
async function fixture(run: (f: { base: string; root: string; file: string; data: Buffer; admin: AdminController; library: MediaLibraryIndex; call: (url: string, method?: string, value?: unknown, user?: string) => Promise<Response> }) => Promise<void>, remote = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-measure-'));
  const file = path.join(root, 'media', 'sample.mp4'); await fs.mkdir(path.dirname(file));
  const data = Buffer.alloc(4 * MiB); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  await fs.writeFile(file, data);
  await fs.writeFile(path.join(root, 'voidplayer.config.json'), JSON.stringify({ mediaRoots: [{ id: 'main', name: '素材', path: 'media' }], indexWatch: false, adminUsers: ['owner', 'other'] }));
  const config = await loadConfig([], 'production', root);
  const library = new MediaLibraryIndex(config.mediaRoots, { watch: false }); await library.refresh();
  const admin = new AdminController(config, library);
  const server = createMediaServer({ roots: library.roots, library, admin, onLog: () => {} });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const actors = Object.fromEntries(['owner', 'other', 'viewer'].map(name => [name, admin.workspaces.identify(undefined, name)]));
  const call = (url: string, method = 'GET', value?: unknown, user = 'owner') => httpFetch(base + url, { method, headers: { origin: remote ? 'http://intranet.test' : base, 'x-voidplayer-action': 'admin', ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...(remote ? { host: 'intranet.test', cookie: `voidplayer-user=${actors[user].id}` } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
  try { await run({ base, root, file, data, admin, library, call }); }
  finally { await admin.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await library.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const endpoint = '/api/admin/measurements';
const settings = { kind: 'download', seconds: 5, limitMiB: 64 };
async function until<T>(read: () => T | null, predicate: (v: T) => boolean) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (value !== null && predicate(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('measurement did not reach expected state');
}

test('measurement is idle until explicitly started and rejects invalid or unauthorized work', () => fixture(async ({ base, call, admin }) => {
  assert.deepEqual(await (await call(endpoint)).json(), { job: null });
  assert.equal((await call(endpoint, 'POST', settings, 'viewer')).status, 403);
  assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })).status, 403);
  for (const value of [{ ...settings, seconds: 100 }, { ...settings, limitMiB: -1 }, { ...settings, kind: 'arbitrary' }, { ...settings, kind: 'storage', mediaId: '/etc/passwd' }]) assert.ok([400, 409].includes((await call(endpoint, 'POST', value)).status));
  assert.equal(admin.measurements.status().job, null);
  const { job } = await (await call(endpoint, 'POST', settings)).json();
  assert.equal((await call(endpoint, 'POST', settings)).status, 409);
  assert.equal((await call(`${endpoint}/${job.id}`, 'DELETE', undefined, 'other')).status, 403);
  assert.equal((await call(`${endpoint}/${job.id}/transfer`, 'POST', undefined, 'other')).status, 403);
  assert.equal((await call(`${endpoint}/${job.id}`, 'DELETE')).status, 200);
  assert.equal(admin.measurements.status().job?.state, 'cancelled');
}, true));

test('memory download is incompressible, bounded and finish records browser observations', () => fixture(async ({ call, admin }) => {
  const { job } = await (await call(endpoint, 'POST', settings)).json();
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const response = await call(`${endpoint}/${job.id}/transfer`, 'POST'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'identity'); assert.match(response.headers.get('cache-control')!, /no-store/);
    const data = new Uint8Array(await response.arrayBuffer()); assert.equal(data.length, MiB); if (!i) assert.ok(new Set(data).size > 200);
    total += data.length;
  }
  const value = await until(() => admin.measurements.status().job, r => r.state === 'completed');
  assert.equal(value.reason, 'limit'); assert.equal(value.bytes, total); assert.equal(value.requests, 64); assert.equal(value.activeRequests, 0);
  assert.equal((await call(`${endpoint}/${job.id}/transfer`, 'POST')).status, 410);
  assert.equal((await call(`${endpoint}/${job.id}/finish`, 'POST', { bytes: total + 1, requests: 64, elapsedMs: 1000 })).status, 400);
  const done = await call(`${endpoint}/${job.id}/finish`, 'POST', { bytes: total, requests: 64, elapsedMs: 1000 }); assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).job.client, { bytes: total, requests: 64, elapsedMs: 1000 });
}));

test('upload drains a bounded body without persisting it and cancellation releases the task', () => fixture(async ({ base, root, call, admin }) => {
  const before = await fs.readdir(root);
  const { job } = await (await call(endpoint, 'POST', { ...settings, kind: 'upload' })).json();
  const response = await fetch(`${base}${endpoint}/${job.id}/transfer`, { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'admin', 'content-type': 'application/octet-stream' }, body: Buffer.alloc(MiB, 25) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { bytes: MiB });
  assert.equal(admin.measurements.status().job?.bytes, MiB); assert.deepEqual(await fs.readdir(root), before);
  assert.equal((await call(`${endpoint}/${job.id}/transfer`, 'POST', { invalid: true })).status, 400);
  await call(`${endpoint}/${job.id}`, 'DELETE'); assert.equal(admin.measurements.status().job?.state, 'cancelled');
  assert.equal((await call(endpoint, 'POST', settings)).status, 202);
}));

test('four-lane media transfer reads real blocks and remains separate from ordinary Range requests', () => fixture(async ({ base, call, library, data, admin }) => {
  const media = library.browse({ recursive: true }).entries[0];
  const { job } = await (await call(endpoint, 'POST', { ...settings, kind: 'concurrent', mediaId: media.id, version: media.version })).json();
  await until(() => admin.measurements.status().job, r => r.state === 'running');
  const results = await Promise.all(Array.from({ length: 4 }, async () => Buffer.from(await (await call(`${endpoint}/${job.id}/transfer`, 'POST')).arrayBuffer())));
  const blocks = Array.from({ length: 4 }, (_, i) => data.subarray(i * MiB, (i + 1) * MiB));
  for (const part of results) { const index = blocks.findIndex(block => block.equals(part)); assert.notEqual(index, -1); blocks.splice(index, 1); }
  assert.equal(blocks.length, 0);
  const range = await fetch(`${base}/api/media/${media.id}?v=${media.version}`, { headers: { range: 'bytes=128-255' } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(128, 256));
  const result = await until(() => admin.measurements.status().job, r => r.activeRequests === 0);
  assert.equal(result.bytes, 4 * MiB); assert.equal(result.concurrency, 4);
  await call(`${endpoint}/${job.id}`, 'DELETE');
}));

test('storage runs on the server, enforces a byte ceiling and stops when cancelled', () => fixture(async ({ base, call, library, admin }) => {
  const media = library.browse({ recursive: true }).entries[0];
  const start = { ...settings, kind: 'storage', mediaId: media.id, version: media.version };
  await call(endpoint, 'POST', start);
  const result = await until(() => admin.measurements.status().job, r => r.state === 'completed');
  assert.equal(result.bytes, 64 * MiB); assert.equal(result.reason, 'limit'); assert.equal(result.requests, 64); assert.ok(result.elapsedMs > 0);
  const { job } = await (await call(endpoint, 'POST', { ...start, limitMiB: 1024 })).json();
  assert.equal((await fetch(base + '/api/ready')).status, 200);
  await call(`${endpoint}/${job.id}`, 'DELETE');
  const cancelled = await until(() => admin.measurements.status().job, r => r.state === 'cancelled');
  assert.equal(cancelled.activeRequests, 0); assert.ok(cancelled.bytes < 1024 * MiB);
}));

test('changed media cannot be read by a previously authorized measurement', () => fixture(async ({ call, library, file, admin }) => {
  const media = library.browse({ recursive: true }).entries[0];
  assert.equal((await call(endpoint, 'POST', { ...settings, kind: 'storage', mediaId: media.id, version: 'old' })).status, 409);
  const { job } = await (await call(endpoint, 'POST', { ...settings, kind: 'concurrent', mediaId: media.id, version: media.version })).json();
  await until(() => admin.measurements.status().job, r => r.state === 'running');
  await fs.writeFile(file, 'replaced');
  const response = await call(`${endpoint}/${job.id}/transfer`, 'POST'); assert.equal(response.status, 500);
  const value = await until(() => admin.measurements.status().job, r => r.state === 'failed'); assert.match(value.error ?? '', /改变/); assert.equal(value.activeRequests, 0); assert.equal(value.bytes, 0);
}));

test('abandoned network tasks expire without more traffic or a browser finish request', () => fixture(async ({ call, admin }) => {
  await call(endpoint, 'POST', settings);
  const value = await until(() => admin.measurements.status().job, r => r.state === 'completed');
  assert.equal(value.reason, 'duration'); assert.equal(value.bytes, 0); assert.ok(value.elapsedMs >= 4900 && value.elapsedMs < 6000);
}));


test('cancelling a stalled upload destroys its stream and releases the single transfer slot', () => fixture(async ({ base, call, admin }) => {
  const { job } = await (await call(endpoint, 'POST', { ...settings, kind: 'upload' })).json();
  let ended!: () => void;
  const closed = new Promise<void>(r => { ended = r; });
  const req = request(`${base}${endpoint}/${job.id}/transfer`, { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'admin', 'content-type': 'application/octet-stream', 'content-length': MiB } });
  req.on('error', () => {}); req.on('close', ended);
  req.on('response', res => res.resume());
  const cancellationAt = performance.now();
  req.write(Buffer.alloc(128 * 1024));
  try {
    await until(() => admin.measurements.status().job, r => r.activeRequests === 1);
    const busy = await fetch(`${base}${endpoint}/${job.id}/transfer`, { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'admin', 'content-type': 'application/octet-stream' }, body: Buffer.alloc(32) });
    assert.equal(busy.status, 429);
    await call(`${endpoint}/${job.id}`, 'DELETE');
    await closed;
    assert.ok(performance.now() - cancellationAt < 2000, 'cancelling a stalled stream must not wait for the duration limit');
    const value = await until(() => admin.measurements.status().job, r => r.state === 'cancelled');
    assert.equal(value.activeRequests, 0); assert.equal(value.bytes, 0);
    assert.equal((await call(endpoint, 'POST', settings)).status, 202);
  } finally { req.destroy(); }
}));


test('concurrent reads wrap a non-aligned file and stop at the exact aggregate byte cap', () => fixture(async ({ call, library, file, admin }) => {
  await fs.writeFile(file, Buffer.alloc(MiB + 17, 97)); await library.refresh();
  const media = library.browse({ recursive: true }).entries[0];
  const { job } = await (await call(endpoint, 'POST', { ...settings, kind: 'concurrent', mediaId: media.id, version: media.version })).json();
  await until(() => admin.measurements.status().job, r => r.state === 'running');
  let received = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const response = await call(`${endpoint}/${job.id}/transfer`, 'POST');
      if (response.status === 410) { await response.body?.cancel(); break; }
      assert.equal(response.status, 200);
      const data = new Uint8Array(await response.arrayBuffer()); assert.ok(data.length > 0 && data.length <= MiB); assert.ok(data.every(byte => byte === 97));
      received += data.length;
    }
  }));
  const result = await until(() => admin.measurements.status().job, r => r.state === 'completed');
  assert.equal(received, 64 * MiB); assert.equal(result.bytes, received); assert.equal(result.reason, 'limit'); assert.equal(result.activeRequests, 0);
}));
