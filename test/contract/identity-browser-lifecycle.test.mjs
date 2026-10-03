import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { loadConfig } from '../../server/config.ts';
import { startService } from '../../server/runtime.ts';
import { httpFetch } from '.././http-request.ts';
import { identityBrowserService, cleanupIdentityBrowser } from '../../scripts/identity-browser-lifecycle.mjs';

for (const host of [undefined, '127.0.0.1']) test(`identity HTTPS restart (${host ?? 'default host'}) keeps its origin when the adjacent guide port is occupied`, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vp-identity-lifecycle-'));
  const blocker = createServer();
  let lifecycle;
  try {
    await mkdir(path.join(temp, 'media'));
    await mkdir(path.join(temp, 'dist'));
    await writeFile(path.join(temp, 'dist/index.html'), 'VoidPlayer');
    const config = await loadConfig(['--https', 'voidplayer.test', ...(host ? ['--host', host] : []), '--folder', path.join(temp, 'media'),
      '--static', path.join(temp, 'dist'), '--data-dir', path.join(temp, 'data'), '--no-logs'], 'production', temp);
    config.port = 0;
    lifecycle = identityBrowserService(config, startService);
    const first = await lifecycle.start();
    const port = first.server.address().port, ca = first.tls.ca;
    const adjacent = port === 65535 ? 65534 : port + 1;
    await lifecycle.close();
    await new Promise((resolve, reject) => {
      // Bind the same address as the guide: on macOS a wildcard listener
      // can coexist with loopback, which would hide the intended conflict.
      // A pre-existing listener provides the same regression condition.
      blocker.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
      blocker.listen(adjacent, config.host, resolve);
    });
    let unexpected;
    try {
      await assert.rejects(async () => { unexpected = await startService({ ...config, httpPort: undefined }); },
        error => error.code === 'EADDRINUSE' && error.port === adjacent);
    } finally { await unexpected?.close(); }
    await lifecycle.start();
    const restarted = await lifecycle.restart();
    assert.equal(restarted.server.address().port, port);
    assert.notEqual(restarted.guide.address().port, adjacent);
    assert.equal(restarted.tls.ca, ca);
    const response = await httpFetch(`https://127.0.0.1:${port}/api/health`, { ca, headers: { connection: 'close' } });
    assert.equal(response.status, 200);
  } finally {
    await lifecycle?.close();
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test('failed restart cannot close the already-closed service again', async () => {
  const original = new Error('listen EADDRINUSE');
  let starts = 0, closes = 0;
  const lifecycle = identityBrowserService({ port: 0 }, async () => {
    if (++starts > 1) throw original;
    return { server: { address: () => ({ port: 12345 }) }, close: async () => { closes++; } };
  });
  await lifecycle.start();
  await assert.rejects(lifecycle.restart(), error => error === original);
  await lifecycle.close(); await lifecycle.close();
  assert.equal(closes, 1);
});

test('partially failed service close is attempted only once', async () => {
  const original = new Error('close failed');
  let closes = 0;
  const lifecycle = identityBrowserService({ port: 0 }, async () => ({
    server: { address: () => ({ port: 12345 }) }, close: async () => { closes++; throw original; },
  }));
  await lifecycle.start();
  await assert.rejects(lifecycle.restart(), error => error === original);
  await lifecycle.close();
  assert.equal(closes, 1);
});

test('all browser cleanup runs without replacing the primary error', async () => {
  const original = new Error('restart failed'), secondary = new Error('browser close failed');
  const called = [], reports = [];
  await assert.rejects(cleanupIdentityBrowser([
    ['browser', () => { called.push('browser'); throw secondary; }],
    ['service', async () => { called.push('service'); }],
    ['certificate trust', () => { called.push('certificate'); }],
    ['temporary directory', async () => { called.push('directory'); }],
  ], { error: original }, (...args) => reports.push(args)), error => error === original);
  assert.deepEqual(called, ['browser', 'service', 'certificate', 'directory']);
  assert.deepEqual(reports, [['Identity browser: browser cleanup failed', secondary]]);
});

test('cleanup failures still fail an otherwise successful browser check', async () => {
  const error = new Error('certificate cleanup failed');
  let removed = false;
  await assert.rejects(cleanupIdentityBrowser([
    ['certificate trust', () => { throw error; }],
    ['temporary directory', async () => { removed = true; }],
  ], undefined, () => {}), failure => failure instanceof AggregateError && failure.errors[0] === error);
  assert.equal(removed, true);
  await cleanupIdentityBrowser([['success', async () => {}]]);
});
