import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {VMAF_SOURCE_REVISION,VMAF_SUPERVISOR_SOURCE_SHA256,VMAF_MODELS,VMAF_CAPABILITY} from '../../shared/analysis/quality/vmaf.ts';
import {agentManifest,serviceCapabilities} from '../../shared/service/agent.ts';
const read=p=>readFile(new URL('../../'+p,import.meta.url),'utf8');
test('official source/model lock, self-description and documented recipe identify one fixed executor',async()=>{
 const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(await read('scripts/native/vmaf-limit.c')).digest('hex'),VMAF_SUPERVISOR_SOURCE_SHA256);assert.match(await read('scripts/native/build-vmaf.mjs'),/LGPL-2.1-or-later/);
 const lock=JSON.parse(await read('scripts/native/vmaf.lock.json'));assert.equal(lock.repository,'https://github.com/Netflix/vmaf.git');assert.equal(lock.revision,VMAF_SOURCE_REVISION);assert.equal(lock.tag,'v3.0.0');for(const model of Object.values(VMAF_MODELS))assert.deepEqual(lock.models[model.file.replace('.json','')],model);
 const manifest=agentManifest({capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,actor:null});assert.equal(manifest.qualityVmaf.sourceRevision,VMAF_SOURCE_REVISION);assert.deepEqual(manifest.qualityVmaf.metrics,{required:['psnr','vmaf'],optional:['ssim']});assert.equal(manifest.qualityVmaf.contentCertification,false);assert.equal(manifest.qualityVmaf.negativePts,false);assert.equal(manifest.qualityVmaf.vfr,false);assert.equal(manifest.capabilities.find(c=>c.id==='quality.vmaf').enabled,false);
 const doc=await read('docs/native-vmaf.md');for(const model of Object.values(VMAF_MODELS))assert.ok(doc.includes(model.sha256));assert.ok(doc.includes(VMAF_SOURCE_REVISION));assert.match(doc,/not the newest model/);assert.match(doc,/not a throughput or real-time acceptance/);assert.match(doc,/reference-integrity certification/);
});
test('real native tests are mandatory in existing full suites, remain outside lightweight identity and include compiled installation',async()=>{
 const manifest=JSON.parse(await read('scripts/testing/manifest.json')),byId=id=>manifest.cases.find(c=>c.id===id);
 for(const id of ['node-native-vmaf-http','node-native-vmaf-lifecycle']){const c=byId(id);assert.equal(c.required,true);assert.ok(c.suites.includes('ci-native-node'));assert.ok(c.fixtures.includes('core'));assert.deepEqual(c.platforms,['linux']);}
 for(const id of ['bun-native-vmaf-http','bun-native-vmaf-lifecycle'])assert.ok(byId(id).suites.includes('ci-native-bun'));
 for(const engine of ['chromium','webkit'])for(const depth of [8,10]){const c=byId(`browser-native-vmaf-${depth}-${engine}`);assert.equal(c.required,true);assert.equal(c.build,true);assert.ok(c.suites.includes('ci-cache'));assert.ok(c.fixtures.includes('core'));assert.ok(!c.suites.some(s=>s.startsWith('ci-identity')));}
 const packaged=await read('scripts/package-release.mjs');for(const worker of ['component-worker.ts','decode-worker.ts'])assert.ok(packaged.includes('server/analysis/vmaf/'+worker));
 assert.match(await read('scripts/check-quality-release.mjs'),/check-native-vmaf-release\.mjs/);assert.match(await read('scripts/check-native-vmaf-release.mjs'),/PATH:empty/);assert.match(await read('scripts/check-native-vmaf-release.mjs'),/officialOracle/);
});
