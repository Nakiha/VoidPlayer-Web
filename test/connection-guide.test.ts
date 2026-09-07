import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { connectionDetails } from '../server/connection-guide.ts';
import { httpFetch } from './http-request.ts';

test('HTTP guide exposes the public CA and a certificate-matching HTTPS URL, without media or admin APIs', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vp-guide-')); let service;
  try {
    await mkdir(path.join(temp, 'media')); await mkdir(path.join(temp, 'dist'));
    await writeFile(path.join(temp, 'dist/index.html'), 'Guide bootstrap');
    const config = await loadConfig(['--folder', 'media', '--https', 'player.test', '--host', '127.0.0.1', '--no-logs'], 'production', temp);
    config.port = 0;
    service = await startService(config);
    const base = `http://127.0.0.1:${(service.guide!.address() as { port: number }).port}`;
    assert.match(await (await fetch(base)).text(), /Guide bootstrap/);
    const info = await (await httpFetch(base + '/api/connection', { headers: { host: 'player.test' } })).json();
    assert.equal(info.httpsUrl, `https://player.test:${(service.server.address() as { port: number }).port}/`);
    assert.equal(info.fingerprint, service.tls!.fingerprint);
    const cert = await fetch(base + info.certificateUrl);
    assert.equal(await cert.text(), service.tls!.ca);
    assert.match(cert.headers.get('content-disposition')!, /attachment/);
    assert.equal((await fetch(base + info.certificateUrl, { method: 'HEAD' })).status, 200);
    for (const url of ['/api/library', '/api/health', '/api/admin/status', '/api/workspaces', '/data/tls/authority.json', '/data/tls/server.json', '/admin']) assert.equal((await fetch(base + url)).status, 404, url);
    assert.equal((await fetch(base + '/api/connection/certificate', { method: 'POST' })).status, 404);
    const hostile = await (await httpFetch(base + '/api/connection', { headers: { host: 'untrusted.example' } })).json();
    assert.equal(hostile.httpsUrl, info.httpsUrl);
    assert.equal(connectionDetails().configured, false);
    assert.equal(connectionDetails({ ...service.tls!, ca: undefined, port: 443 }, 'player.test').certificateUrl, null);
  } finally { await service?.close(); await rm(temp, { recursive: true, force: true }); }
});

test('guide port validation and explicit opt-out', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vp-guide-config-')); let service;
  try {
    for (const value of ['0', '-1', '65536', '5180']) await assert.rejects(loadConfig(['--folder', temp, '--http-port', value], 'production', temp), /httpPort/);
    const config = await loadConfig(['--folder', temp, '--https', 'player.test', '--host', '127.0.0.1', '--no-http-guide', '--no-logs'], 'production', temp); config.port = 0;
    service = await startService(config, false);
    assert.equal(service.guide, undefined);
  } finally { await service?.close(); await rm(temp, { recursive: true, force: true }); }
});
