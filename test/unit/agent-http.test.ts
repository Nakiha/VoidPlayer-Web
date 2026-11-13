import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../../server/config.ts';
import { startService } from '../../server/runtime.ts';
import { createMediaServer } from '../../server/app.ts';
import { MediaLibraryIndex } from '../../server/library.ts';
import type { AnnotationOperation } from '../../shared/review/annotation-record.ts';
import { AGENT_DOCUMENTS } from '../../server/agent-guide.ts';
import { agentManifest, serviceCapabilities } from '../../shared/service/agent.ts';
import {AGENT_WORKFLOWS,agentOperation,agentTask} from '../../shared/service/agent-operations.ts';

test('runtime discovery separates implementation, deployment and source/session readiness', () => {
  const manifest = agentManifest({ capabilities: serviceCapabilities(false, false), libraryReady: false, frontendAvailable: true, actor: null });
  const byId = (id: string) => manifest.capabilities.find(capability => capability.id === id)!;
  assert.equal(byId('library.browse').readiness, 'index-warming');
  assert.equal(byId('media.read').readiness, 'per-source');
  assert.equal(byId('annotations.write').implemented, true);
  assert.equal(byId('annotations.write').enabled, false);
  assert.equal(byId('session.view').readiness, 'requires-live-session');
  assert.equal(byId('bridge.local-mcp').implemented,true);
  assert.equal(byId('bridge.local-mcp').enabled,false,'manifest without a loopback page host grants no bridge capability');
});

test('ordinary HTTP discovers, attributes and commits annotations without frontend assets or a browser', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-agent-http-'));
  await mkdir(path.join(dir, 'media'));
  // Content is deliberately not decoded: annotation persistence accepts a supplied description.
  await writeFile(path.join(dir, 'media/B.mp4'), 'opaque test media bytes');
  const config = await loadConfig(['--folder', 'media', '--host', '127.0.0.1', '--no-logs'], 'production', dir);
  config.port = 0; config.staticDir = path.join(dir, 'no-frontend'); config.indexWatch = false;
  let service = await startService(config, false);
  const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const writeHeaders = { origin: base, 'x-voidplayer-action': 'annotation', 'content-type': 'application/json' };
  try {
    await service.library.refresh();
    assert.equal((await fetch(base)).status, 404, 'no GUI was installed or opened');
    for (const [url, contents] of Object.entries(AGENT_DOCUMENTS)) {
      const get = await fetch(base + url);
      assert.equal(get.status, 200); assert.equal(get.headers.get('set-cookie'), null);
      assert.match(get.headers.get('link')!, /\/api\/agent/);
      assert.equal(await get.text(), contents);
      const head = await fetch(base + url, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(contents));
      for (const match of contents.matchAll(/\]\((\/[^)]+\.md)\)/g)) assert.ok(AGENT_DOCUMENTS[match[1]], `unresolved task link ${match[1]}`);
    }
    assert.ok(Buffer.byteLength(AGENT_DOCUMENTS['/llms.txt']) < 2000);
    const discovery = await fetch(base + '/api/agent'), manifest = await discovery.json();
    assert.equal(manifest.schema, 'voidplayer-agent'); assert.equal(manifest.actor, null);
    const tasks=await (await fetch(base+manifest.links.taskCatalog)).json();
    assert.equal(tasks.schema,'voidplayer-agent-tasks');assert.equal(tasks.version,1);assert.equal(tasks.entries.length,AGENT_WORKFLOWS.length);
    for(const task of tasks.entries){
      const detail=await (await fetch(base+task.links.describe)).json();assert.equal(detail.id,task.id);assert.equal(detail.version,1);
      for(const operation of detail.operations){
        const response=await fetch(base+operation.links.describe),contract=await response.json();assert.equal(contract.id,operation.id);assert.equal(contract.method,operation.method);assert.equal(contract.path,operation.path);assert.equal(contract.execution.requiresBrowser,false);
        assert.match(response.headers.get('content-type')!,/^application\/json/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('set-cookie'),null);
        const head=await fetch(base+operation.links.describe,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),response.headers.get('content-length'));
        assert.equal((await fetch(base+operation.links.describe,{method:'POST'})).status,405);assert.equal((await fetch(base+operation.links.describe+'?unknown=1')).status,400);
        assert.ok(AGENT_DOCUMENTS[operation.links.guide]);for(const next of contract.links.next)assert.equal((await fetch(base+next)).status,200);
      }
    }
    assert.equal((await fetch(base+'/api/agent/operations/unknown')).status,404);
    assert.equal((await fetch(base+'/api/agent/tasks/unknown')).status,404);
    assert.equal(discovery.headers.get('cache-control'), 'no-store');
    assert.equal(manifest.capabilities.find((c: { id: string }) => c.id === 'annotations.write').readiness, 'needs-identity');
    assert.deepEqual((await (await fetch(base + '/api/users')).json()).users, []);
    const head = await fetch(base + '/api/agent', { method: 'HEAD' }); assert.equal(await head.text(), '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(JSON.stringify(manifest)));
    const readonly = await fetch(base + '/api/agent', { method: 'POST' });
    assert.equal(readonly.status, 405); assert.equal((await readonly.json()).code, 'method-not-allowed');

    const endpoint = base + '/api/annotations/spaces/default';
    const noIdentity = await fetch(endpoint, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(noIdentity.status, 409); assert.equal((await noIdentity.json()).code, 'identity-required');
    const identity = await fetch(base + '/api/identity', { method: 'POST', headers: { ...writeHeaders, 'x-voidplayer-action': 'identity' }, body: JSON.stringify({ name: 'HTTP reviewer' }) });
    assert.equal(identity.status, 200);
    const actor = (await identity.json()).actor, cookie = identity.headers.get('set-cookie')!.split(';')[0];
    const headers = { ...writeHeaders, cookie, 'x-voidplayer-actor': actor.id };
    const entry = (await (await fetch(base + '/api/library/browse?recursive=1')).json()).entries[0];
    const operation: AnnotationOperation = { operationId: 'http-create', id: 'events', revision: 0, action: 'put', client: { kind: 'agent', id: 'headless-test' }, document: {
      media: [{ id: 'snapshot-B', name: entry.name, size: entry.size, lastModified: entry.lastModified, codec: 'fixture-description', decoder: 'webcodecs', width: 320, height: 180, durationUs: 1000000, firstPtsUs: 0, source: { kind: 'library', id: entry.id, url: `${base}/api/media/${entry.id}/content?v=${entry.version}` } }],
      mark: { id: 'events', text: 'Headless review', severity: 3, origin: 'agent', createdAt: '2026-10-23T00:00:00Z', slot: 'H', mediaId: 'snapshot-B', frame: { ptsUs: 0, sourcePtsUs: 0, durationUs: 40000 }, comparison: [], region: null },
    } };
    const submit = (body: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const denied = await submit(operation, { origin: 'https://other.test' });
    assert.equal(denied.status, 403);
    const diagnostic = await denied.json();
    assert.equal(diagnostic.code, 'origin-required'); assert.equal(diagnostic.requestId, denied.headers.get('x-request-id'));
    assert.equal((await fetch(base + diagnostic.links.help)).status, 200);
    const missingOrigin = await submit(operation, { origin: '' }); assert.equal(missingOrigin.status, 403);
    assert.equal((await submit(operation, { 'x-voidplayer-actor': 'different-user' })).status, 409);
    const committed = await submit(operation), requestId = committed.headers.get('x-request-id');
    assert.equal(committed.status, 200); const record = await committed.json();
    assert.equal(record.revision, 1); assert.equal(record.document.mark.author.id, actor.id);
    assert.deepEqual(await (await submit(operation)).json(), record, 'lost acknowledgement retry is idempotent');
    assert.equal((await fetch(endpoint + '/events')).status, 200, 'existing annotation IDs are not shadowed by the event route');
    const changed = { ...operation, document: { ...operation.document!, mark: { ...operation.document!.mark, text: 'other content' } } };
    assert.equal((await (await submit(changed)).json()).code, 'operation-id-reused');
    assert.equal((await (await submit({ ...changed, operationId: 'stale' })).json()).code, 'annotation-revision-conflict');
    const events = await (await fetch(base + '/api/annotations/events/default?after=0')).json();
    assert.equal(events.events.length, 1); assert.equal(events.events[0].requestId, requestId);
    assert.deepEqual(events.events[0].client, operation.client);
    assert.deepEqual(events.events[0].target.source, { id: entry.id, version: entry.version });
    for (const cursor of ['-1', 'NaN', '1.5', '9007199254740992', '']) {
      const invalid = await fetch(base + '/api/annotations/events/default?after=' + cursor);
      assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'invalid-event-cursor');
    }
    const ready = await (await fetch(base + '/api/agent', { headers: { cookie } })).json();
    assert.equal(ready.capabilities.find((c: { id: string }) => c.id === 'annotations.write').readiness, 'ready');
    config.port = (service.server.address() as { port: number }).port;
    await service.close(); service = await startService(config, false);
    assert.deepEqual(await (await submit(operation)).json(), record);
    assert.equal((await (await fetch(base + '/api/annotations/events/default?after=0')).json()).events.length, 1);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('read-only deployment advertises unavailable writes and still serves embedded task documents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-agent-readonly-'));
  const library = new MediaLibraryIndex([dir], { database: path.join(dir, 'index.sqlite'), watch: false });
  const server = createMediaServer({ roots: [dir], library, onLog() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const manifest = await (await fetch(base + '/api/agent')).json();
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.capabilities.annotations, false);
    assert.equal(manifest.capabilities.find((c: { id: string }) => c.id === 'annotations.write').enabled, health.capabilities.annotations);
    const response = await fetch(base + '/api/annotations/events/default');
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'storage-unavailable');
    assert.equal((await fetch(base + '/agent/annotations.md')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await library.close(); await rm(dir, { recursive: true, force: true }); }
});

test('removed discovery, task and scoring APIs are absent while normal library and annotation APIs remain', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-removed-features-'));
  const library = new MediaLibraryIndex([dir], { database: path.join(dir, 'index.sqlite'), watch: false });
  const server = createMediaServer({ roots: [dir], library, onLog() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const manifest = await (await fetch(base + '/api/agent')).json();
    assert.equal(manifest.capabilities.some((entry: { id: string }) => /quality|tasks|discovery|preparations|technical-filter/.test(entry.id)), false);
    const media = 'a'.repeat(24);
    for (const path of ['/api/quality/psnr-pair', '/api/quality/jobs', '/api/quality/ranges', '/api/quality/correspondence-plans',
      '/api/quality/reference-relations', '/api/quality/vmaf/capability', '/api/quality/xpsnr/jobs', '/api/quality/cambi/jobs',
      '/api/library','/api/library?refresh=1','/api/admin/scan','/api/admin/frame-indexes','/api/shares',
      `/api/reviews/${'0'.repeat(36)}`,`/api/media/${media}/metadata`,`/api/media/${media}/info`,`/api/media/${media}/playback-container`,
      '/api/tasks', '/api/library/discovery', '/api/library/preparations', '/api/library/technical-filter',
      `/api/media/${media}/discovery`, `/api/media/${media}/psnr-index`, '/api/admin/quality-resources']) {
      for (const method of ['GET', 'POST']) assert.equal((await fetch(base + path, { method })).status, 404, method + ' ' + path);
    }
    for (const suffix of ['content','container','location','thumbnail','thumbnail-status','frame-index','bitstream-analysis/capabilities'])
      assert.equal((await fetch(`${base}/api/media/${media}/${suffix}`)).status,400,`missing version: ${suffix}`);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/library/browse')).status, 200);
    assert.equal(agentTask('quality.single'), null);
    assert.equal(agentTask('tasks'), null);
    assert.equal(agentOperation('library.prepare', manifest.capabilities), null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await library.close(); await rm(dir, { recursive: true, force: true });
  }
});
