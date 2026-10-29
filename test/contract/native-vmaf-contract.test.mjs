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
 for(const id of ['node-native-vmaf-http','node-native-vmaf-lifecycle']){const c=byId(id);assert.equal(c.required,true);assert.ok(c.suites.includes('ci-native-node'));assert.ok(c.fixtures.includes('core'));assert.deepEqual(c.platforms,['linux']);assert.ok(!c.tools.includes('ffmpeg'),'native job consumes committed independent raw oracles without runtime FFmpeg');}
 for(const id of ['bun-native-vmaf-http','bun-native-vmaf-lifecycle'])assert.ok(byId(id).suites.includes('ci-native-bun'));
 for(const engine of ['chromium','webkit'])for(const depth of [8,10]){const c=byId(`browser-native-vmaf-${depth}-${engine}`);assert.equal(c.required,true);assert.equal(c.build,true);assert.ok(c.suites.includes('ci-cache'));assert.ok(c.fixtures.includes('core'));assert.ok(!c.suites.some(s=>s.startsWith('ci-identity')));}
 const packaged=await read('scripts/package-release.mjs');for(const worker of ['component-worker.ts','decode-worker.ts'])assert.ok(packaged.includes('server/analysis/vmaf/'+worker));
 const fixed=JSON.parse(await read('test/helpers/native-vmaf-samples.json'));assert.equal(fixed.samples.length,5);assert.match(fixed.rawOracle,/ffmpeg decode/);assert.ok(!/execFileSync\('ffmpeg'/.test(await read('test/helpers/native-vmaf.mjs')));
 assert.match(await read('scripts/check-quality-release.mjs'),/check-analysis-quality-release\.mjs/);assert.match(await read('scripts/check-analysis-quality-release.mjs'),/env.PATH = empty/);assert.match(await read('scripts/check-analysis-quality-release.mjs'),/analysis-quality-oracle.json/);const compiled=byId('release-analysis-quality');assert.equal(compiled.required,true);assert.deepEqual(compiled.platforms,['linux','darwin','win32']);
});

test('MP4 native matrix is explicitly advertised and adds every required browser cell without changing the official executor',async()=>{
 assert.deepEqual(VMAF_CAPABILITY.containers.mp4,{sampleEntries:['avc1','hvc1'],matrix:['h264-8','hevc-8','hevc-10'],fragmented:false});
 assert.deepEqual(VMAF_CAPABILITY.associationVersions,[1,2]);assert.deepEqual(VMAF_CAPABILITY.resultVersions,[1,2]);
 const manifest=JSON.parse(await read('scripts/testing/manifest.json'));
 for(const engine of ['chromium','webkit'])for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]]){
  const row=manifest.cases.find(c=>c.id===`browser-mp4-vmaf-${codec}-${depth}-${engine}`);assert.ok(row?.required);assert.equal(row.build,true);assert.deepEqual(row.platforms,['linux']);assert.ok(row.suites.includes('ci-cache'));assert.ok(!row.suites.some(s=>s.startsWith('ci-identity')));
  assert.deepEqual(row.command,['node','scripts/native/run-vmaf-tests.mjs','node','scripts/check-mp4-vmaf-browser.mjs',engine,codec,String(depth)]);assert.equal(row.timeoutMs,300000);
 }
 const fixed=JSON.parse(await read('test/helpers/native-vmaf-mp4-samples.json'));assert.deepEqual(fixed.samples.map(s=>[s.codec,s.depth]),[['h264',8],['hevc',8],['hevc',10]]);assert.match(fixed.recipe.verification,/no content certification/);
 for(const row of fixed.samples)for(const side of ['reference','distorted'])assert.match(row[side].rawSha256,/^[a-f0-9]{64}$/);
 assert.match(await read('scripts/check-mp4-vmaf-browser.mjs'),/GUI-discovery-preparation/);
});
