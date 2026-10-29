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
import {AGENT_OPERATIONS,AGENT_WORKFLOWS,agentOperation,agentTask} from '../../shared/service/agent-operations.ts';
import {DISCOVERY_DICTIONARY} from '../../shared/media/discovery.ts';
import {VMAF_CAPABILITY} from '../../shared/analysis/quality/vmaf.ts';
import {QUALITY_RANGE_LIMITS} from '../../shared/analysis/quality/ranges.ts';

test('runtime discovery separates implementation, deployment and source/session readiness', () => {
  const manifest = agentManifest({ capabilities: serviceCapabilities(false, false), libraryReady: false, frontendAvailable: true, qualityJobsEnabled: true, actor: null });
  const byId = (id: string) => manifest.capabilities.find(capability => capability.id === id)!;
  assert.equal(byId('library.browse').readiness, 'index-warming');
  assert.equal(byId('media.read').readiness, 'per-source');
  assert.equal(byId('annotations.write').implemented, true);
  assert.equal(byId('annotations.write').enabled, false);
  assert.equal(byId('session.view').readiness, 'requires-live-session');
  assert.equal(byId('quality.jobs').implemented, true);assert.equal(byId('quality.jobs').readiness, 'needs-identity');
  assert.equal(byId('quality.jobs').requiresBrowser, false);assert.deepEqual(manifest.qualityJobs.metrics, ['psnr','ssim']);
  assert.equal(manifest.qualityJobs.scope, 'single-explicit-frame-pair');assert.equal(manifest.qualityJobs.submit, '/api/quality/jobs');
  assert.equal(manifest.qualityJobs.observerDisconnectCancels, false);assert.equal(manifest.qualityJobs.automaticRetry, false);
  assert.equal(manifest.qualityJobs.buildsIndexes, false);assert.equal(manifest.qualityJobs.sharedWork, false);
  assert.equal(manifest.qualityJobs.spatial.optional,true);assert.equal(manifest.qualityJobs.spatial.limits.maxBlocks,64);assert.equal(manifest.qualityJobs.spatial.ranking,'aggregate-mse-desc-row-major-ties');
  const temporary = agentManifest({capabilities:serviceCapabilities(false,false),libraryReady:true,actor:{id:'actor',name:'A'}}).capabilities.find(c=>c.id==='quality.jobs')!;
  assert.equal(temporary.implemented,true);assert.equal(temporary.enabled,false);assert.equal(temporary.readiness,'unavailable');
  assert.equal(byId('compute.workers').implemented,false);
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
      media: [{ id: 'snapshot-B', name: entry.name, size: entry.size, lastModified: entry.lastModified, codec: 'fixture-description', decoder: 'webcodecs', width: 320, height: 180, durationUs: 1000000, firstPtsUs: 0, source: { kind: 'library', id: entry.id, url: `${base}/api/media/${entry.id}?v=${entry.version}` } }],
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
    assert.equal(ready.capabilities.find((c: { id: string }) => c.id === 'quality.jobs').readiness, 'per-source');
    assert.deepEqual(ready.qualityJobs.metrics, ['psnr','ssim']);
    const jobs = await fetch(base + ready.qualityJobs.changes, {headers:{cookie}});
    assert.equal(jobs.status, 200);assert.deepEqual((await jobs.json()).entries, [], 'discovery and annotation commands do not create scoring jobs');
    config.port = (service.server.address() as { port: number }).port;
    await service.close(); service = await startService(config, false);
    assert.deepEqual(await (await submit(operation)).json(), record);
    assert.equal((await (await fetch(base + '/api/annotations/events/default?after=0')).json()).events.length, 1);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('progressive descriptions reuse authoritative limits and distinguish conditional VMAF from metadata and CAMBI',()=>{
  assert.equal(new Set(AGENT_OPERATIONS.map(o=>o.id)).size,AGENT_OPERATIONS.length);
  for(const op of AGENT_OPERATIONS){assert.ok(agentTask(op.task));for(const id of op.next)assert.ok(AGENT_OPERATIONS.some(o=>o.id===id));}
  assert.equal(agentOperation('range.submit',[])!.request.limits,QUALITY_RANGE_LIMITS);
  assert.equal(agentOperation('library.discover',[])!.request.limits,DISCOVERY_DICTIONARY.query);
  const m=agentManifest({capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,nativeVmaf:{enabled:false,reason:'component-unavailable'},actor:null});
  const native=m.qualityJobs.source.additionalContainers.mp4.nativeSequenceMetrics;
  assert.deepEqual(native.vmaf.containers,VMAF_CAPABILITY.containers);assert.equal(native.cambi.implemented,true);assert.equal(m.qualityVmaf.deployment.enabled,false);
  assert.match(DISCOVERY_DICTIONARY.fields.quality,/Metadata stream IDs/);
  assert.ok(AGENT_DOCUMENTS['/agent/quality.md'].length<2500);assert.ok(AGENT_DOCUMENTS['/agent/quality/reference.md'].length>10000);
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

test('temporary library deployment never advertises or accepts durable jobs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-agent-temporary-'));
  const library = new MediaLibraryIndex([dir], {watch:false});
  const server = createMediaServer({roots:[dir],library,onLog(){}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const manifest = await fetch(base+'/api/agent').then(r=>r.json());
    const capability = manifest.capabilities.find((c:{id:string})=>c.id==='quality.jobs');
    assert.equal(capability.implemented,true);assert.equal(capability.enabled,false);assert.equal(capability.readiness,'unavailable');
    const response = await fetch(base+'/api/quality/jobs',{headers:{cookie:'voidplayer-user=guest-00000000-0000-4000-8000-000000000001'}});
    assert.equal(response.status,503);assert.equal((await response.json()).code,'quality-storage-unavailable');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await library.close();await rm(dir,{recursive:true,force:true});}
});

test('quality discovery and guides disclose candidate transaction, SSIM and opaque GOP identity consistently',async()=>{
 const manifest=agentManifest({capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,actor:{id:'a',name:'A'}});
 assert.equal(manifest.annotations.qualityCandidate.action,'create-quality-candidate');assert.equal(manifest.annotations.qualityCandidate.receiptBeforeResultLookup,true);assert.equal(manifest.annotations.qualityCandidate.workspaceVersion,3);assert.equal(manifest.annotations.qualityCandidate.playbackRequired,false);
 assert.deepEqual(manifest.annotations.qualityCandidate.callerFields,['text','severity']);assert.deepEqual(manifest.annotations.qualityCandidate.transaction,['annotation','evidence','receipt','event']);
 assert.equal(manifest.qualityJobs.sourceBuild.method,'POST');assert.equal(manifest.qualityJobs.sourceBuild.automatic,false);assert.equal(manifest.qualityJobs.sourceBuild.limits.maxSourceBytes,64*1024*1024);assert.equal(manifest.qualityJobs.presentedInput.binding,'unbound-until-readonly-exact-au-cache-join');assert.equal(manifest.qualityJobs.presentedInput.nativePixelsScored,false);
 const guides=JSON.stringify(AGENT_DOCUMENTS);for(const phrase of ['create-quality-candidate','annotation-context-unavailable','not-subjectively-assessed','packet-identity-gop-v1','Zero CTS does not imply immediate output','concealmentDetection=unavailable','capture_presented_quality_frame','quality-source-build','configurationHex','UNBOUND'])assert.ok(guides.includes(phrase),phrase);
 assert.ok(!guides.includes('Delayed/reordered pictures,'),'guide must not claim all delayed pictures reject');
 const {readFile}=await import('node:fs/promises');const doc=await readFile(new URL('../../docs/agent-http.md',import.meta.url),'utf8');assert.ok(!doc.includes('SSIM/VMAF/CAMBI'));assert.match(doc,/create-quality-candidate/);assert.match(doc,/opaque token/);
});


test('CAMBI progressive operations retain single-source admission and unavailable recovery without metric substitution',()=>{
 const m=agentManifest({capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,actor:{id:'owner',name:'Owner'},nativeCambi:{enabled:true,reason:null}});
 assert.deepEqual(m.qualityReexecution.kinds,['single','range','vmaf','xpsnr','cambi']);assert.equal(m.qualityCambi.reexecution.implemented,true);assert.deepEqual(m.qualityCambi.reexecution.eligibleStates,['failed','interrupted','cancelled']);assert.equal(agentOperation('cambi.reexecute',m.capabilities)!.execution.host,'service-with-analysis-wasm');
 const task=agentTask('quality.cambi')!;assert.equal(task.operations.length,13);const submit=agentOperation('cambi.submit',m.capabilities)!;assert.equal(submit.availability.enabled,true);assert.equal(submit.request.schema,'voidplayer-cambi-job');assert.equal(submit.execution.requiresBrowser,false);assert.equal(submit.write!.action,'quality-job');assert.ok(!submit.next.includes('plan.create'));
 assert.match(AGENT_DOCUMENTS['/agent/quality/cambi.md'],/no reference relation|reference relationship/i);assert.match(AGENT_DOCUMENTS['/agent/quality/cambi.md'],/strict.*MP4/);assert.match(AGENT_DOCUMENTS['/agent/quality.md'],/CAMBI uses one source and no C plan/);
});
