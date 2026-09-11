import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { connectionDetails } from '../server/connection-guide.ts';
import { httpFetch } from './http-request.ts';

test('HTTP and HTTPS share pages and APIs, with a certificate-matching player destination', async () => {
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
    for(const origin of [base,`http://127.0.0.1:${(service.server.address() as {port:number}).port}`]){
      for(const url of ['/api/library','/api/health','/api/admin/status','/api/workspaces','/llms.txt'])assert.equal((await fetch(origin+url)).status,200,url);
      for(const url of ['/data/tls/authority.json','/data/tls/server.json'])assert.equal((await fetch(origin+url)).status,404,url);
      assert.match(await (await fetch(origin+'/llms.txt')).text(),/HTTP and HTTPS both/);
      assert.equal((await fetch(origin+'/api/connection/probe')).status,409);
    }
    const probe=await httpFetch(`https://127.0.0.1:${(service.server.address() as {port:number}).port}/api/connection/probe`,{ca:service.tls!.ca,servername:'player.test'});
    assert.equal(probe.status,200);assert.equal(probe.headers.get('access-control-allow-origin'),'*');assert.deepEqual(await probe.json(),{service:'voidplayer-connection',https:true});
    assert.equal((await fetch(base + '/api/connection/certificate', { method: 'POST' })).status, 405);
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
