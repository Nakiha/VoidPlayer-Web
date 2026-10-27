import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {nativeFixture,officialOracle,until} from '../test/helpers/native-vmaf.mjs';
import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';
import {chooseTestGuest} from './test-identity.mjs';
import {recordBrowserEvidence,saveBrowserFailure} from './browser-failure-evidence.mjs';

const engine=process.argv[2]??'chromium',codec=process.argv[3]??'h264',depth=Number(process.argv[4]??8);
assert.ok(['chromium','webkit'].includes(engine)&&['h264','hevc'].includes(codec)&&[8,10].includes(depth)&&(codec!=='h264'||depth===8));
const root=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??`.run/mp4-vmaf-browser/${engine}-${codec}-${depth}`);
const reports=[];
for(const containers of [['mp4','mp4'],['mp4','flv'],['flv','mp4']])await runCase(containers);
await writeFile(path.join(root,'results.json'),JSON.stringify({engine,codec,depth,reports},null,2));

async function runCase(containers){
 const directory=path.join(root,containers.join('-'));await mkdir(directory,{recursive:true});
 let f,browser,context,page,viewer,evidence,phase='setup',nativePid=0;const errors=[];
 const beat=setInterval(()=>console.log(JSON.stringify({engine,codec,depth,containers,phase})),10000).unref();
 try{
  f=await nativeFixture({depth,codec,distorted:true,containers,prepare:false,staticDir:'dist'});
  for(const e of f.entries){const response=await f.request(`/api/media/${e.id}/psnr-source?v=${e.version}`);assert.equal(response.status,409,'ordinary discovery has not granted scoring trust: '+await response.text());}
  const runner=f.service.library.qualityVmaf.runner,run=runner.run.bind(runner);
  runner.run=(input,snapshot,signal,hooks)=>run(input,snapshot,signal,{...hooks,process:p=>{hooks.process(p);if(p){nativePid=p.pid;process.kill(p.pid,'SIGSTOP');}}});
  browser=await({chromium,webkit}[engine]).launch({headless:true,...(engine==='webkit'&&process.env.VOIDPLAYER_WEBKIT_EXECUTABLE?{executablePath:process.env.VOIDPLAYER_WEBKIT_EXECUTABLE}:{})});
  context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:1000}});await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  phase='independent-player';
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=10:duration=120','-c:v','libx264','-preset','ultrafast','-threads','1','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(f.media,'A.mp4')],{stdio:'pipe'});
  await f.service.library.refresh();const [a]=await waitForAnnotationMedia(f.service.library,['A.mp4']);const player=await context.newPage();await player.goto(f.base);await chooseTestGuest(player);await player.waitForFunction(()=>!!window.voidPlayer);
  await player.evaluate(async url=>{const b=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([b],'A.mp4'));},`${f.base}/api/media/${a.id}?v=${a.version}`);
  await player.waitForFunction(()=>!window.voidPlayer.getState().busy&&!!window.voidPlayer.getState().tracks[0]?.frame);await player.evaluate(()=>window.voidPlayer.play());await player.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);const before=await player.evaluate(()=>window.voidPlayer.getState());
  phase='GUI-discovery-preparation';page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(f.base+'/admin/#discovery');
  for(const [i,e]of f.entries.entries()){
   await page.locator('#discovery-search').fill(e.name);await page.locator('#discovery-search-button').click();await page.locator(`[data-source-id="${e.id}"]`).click();await page.waitForFunction(id=>document.querySelector('#discovery-source').textContent.startsWith(id),e.id);
   for(const button of ['probe','index']){
    const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/library/preparations'&&r.request().method()==='POST'),page.locator('#discovery-'+button).click()]);assert.equal(r.status(),202);
    await page.waitForFunction(({id,operation})=>{const j=JSON.parse(document.querySelector('#discovery-job').textContent||'null');if(j?.input?.source?.id!==id||j.input.operation!==operation)return false;if(['failed','interrupted','cancelled'].includes(j.state))throw Error(JSON.stringify(j));return j.state==='completed';},{id:e.id,operation:button==='probe'?'probe':'quality-index'});
   }
   const proof=await page.evaluate(()=>JSON.parse(document.querySelector('#discovery-job').textContent).result);assert.equal(proof.binding.indexIdentity.kind,containers[i]);assert.equal(proof.producer.producer,containers[i]==='mp4'?'server-mp4-scan-v1':'server-flv-scan-v1');
  }
  phase='GUI-C-plan';await page.locator('[data-pane="quality"]').click();
  for(const [i,side]of ['reference','distorted'].entries()){const field=page.locator(`[data-clock-source="${side}"]`);await field.locator('[data-clock-search]').fill(f.entries[i].name);await field.locator('[data-clock-search-button]').click();await field.locator(`[data-clock-media="${f.entries[i].id}"]`).click();}
  const declaration='Explicit MP4/native VMAF relation; not content certification';await page.locator('#quality-clock-declaration').fill(declaration);
  for(const [key,value]of Object.entries({start:0,end:10000000,offset:0}))await page.locator(`[data-clock-segment] [data-segment-field="${key}"]`).fill(String(value));
  await page.locator('#quality-clock-save-relation').click();await page.waitForFunction(s=>document.querySelector('#quality-clock-relation').textContent.includes(s),declaration);
  await page.locator('#quality-clock-pin').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-builds').textContent.includes('Distorted'));
  await page.locator('#quality-clock-plan-form details > summary').click();
  for(const [key,value]of Object.entries({start:0,end:7,x:0,y:0,width:128,height:96,'pair-read':1048576,'pair-input':1048576,'total-read':33554432,'total-input':33554432}))await page.locator('#quality-clock-'+key).fill(String(value));
  await page.locator('#quality-clock-ssim').check();await page.locator('#quality-clock-grid').check();await page.locator('#quality-clock-plan-submit').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-title').textContent.includes('completed'));
  await page.locator('#quality-clock-vmaf').click();assert.match(await page.locator('#vmaf-plan').inputValue(),/^[a-f0-9-]{36}$/);await page.locator('#vmaf-cadenceUs').fill('250000');await page.locator('#vmaf-ssim').check();
  assert.equal((await f.json('/api/quality/ranges')).entries.length,0,'C plan does not secretly start another scorer');
  phase='GUI-unknown-submit';let lost=false;const posts=[];
  await context.route('**/api/quality/vmaf/jobs',async route=>{if(route.request().method()==='POST'){posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');return;}}await route.continue();});
  await page.locator('#vmaf-submit').click();await page.waitForFunction(()=>!document.querySelector('#vmaf-retry').hidden&&document.querySelector('#vmaf-inputs').disabled);await until(()=>nativePid,Boolean,'Actual native process not held');
  await page.reload();await page.locator('#vmaf-retry').waitFor({state:'visible'});await page.locator('#vmaf-retry').click();await page.waitForFunction(()=>document.querySelector('#vmaf-title').textContent.includes('running'));
  assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.equal(posts[0].body,posts[1].body);
  const jobs=await f.json('/api/quality/vmaf/jobs');assert.equal(jobs.entries.length,1);const id=jobs.entries[0].id;
  phase='close-observer-while-native-held';await page.close();assert.equal((await f.json('/api/quality/vmaf/jobs/'+id)).state,'running');process.kill(nativePid,'SIGCONT');nativePid=0;
  const job=await f.wait(id);assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.metrics.psnr.state,'completed');assert.equal(job.metrics.ssim.state,'completed');
  const summary=await f.json(`/api/quality/vmaf/jobs/${id}/result`),oracle=await officialOracle(f,depth);assert.deepEqual(summary.vmaf.frames,oracle.result.frames.map(v=>({index:v.frameNum,score:v.metrics.vmaf})));assert.deepEqual(summary.vmaf.pooled,oracle.result.pooled_metrics.vmaf);assert.equal(summary.raw.referenceSha256,oracle.hashes[0]);assert.equal(summary.raw.distortedSha256,oracle.hashes[1]);
  phase='reopen-history-and-publish';page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(f.base+'/admin/#quality');await page.locator(`[data-vmaf-job="${id}"]`).click();await page.waitForFunction(()=>document.querySelector('#vmaf-title').textContent.includes('completed'));await page.locator('[data-vmaf-frame="0"]').waitFor();
  await page.locator('#vmaf-maxScore').fill('100');await page.locator('#vmaf-limit').fill('1');await page.locator('#vmaf-text').fill('Explicit full-frame temporal native MP4 measurement');await page.locator('#vmaf-publish').click();await page.locator('[data-vmaf-candidate]').waitFor();
  const publication=await f.json(`/api/quality/vmaf/jobs/${id}/candidates`),record=await f.json('/api/annotations/spaces/default/'+publication.createdIds[0]),value=record.document.mark.qualityEvidence[0].value;assert.equal(value.version,2);assert.equal(value.sequenceVmaf.version,2);assert.equal(record.document.mark.qualityCandidate.assessment,'not-subjectively-assessed');
  phase='cross-actor-original-viewer';const other=await browser.newContext();await other.addCookies([{name:'voidplayer-user',value:'guest-'+randomUUID(),url:f.base}]);
  await other.addInitScript(()=>{const Native=window.Worker;window.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data?.ok&&data.result?.frames)window.__vmafPairHashes=Promise.all(data.result.frames.map(async f=>{const rows=[],unit=f.description.yuv.bitDepth>8?2:1;for(const p of f.description.yuv.planes)for(let y=0;y<p.height;y++)rows.push(f.pixels.subarray(p.offset+y*p.stride,p.offset+y*p.stride+p.width*unit));const packed=new Uint8Array(rows.reduce((n,r)=>n+r.length,0));let at=0;for(const row of rows){packed.set(row,at);at+=row.length;}return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packed)),b=>b.toString(16).padStart(2,'0')).join('');}));});}};});
  viewer=await other.newPage();viewer.on('pageerror',e=>errors.push(e.message));const requests=[];viewer.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));await viewer.goto(await page.locator('[data-vmaf-candidate]').getAttribute('href'));await viewer.locator('#pair-view[data-state="ready"]').waitFor({timeout:30000});
  const frameBytes=128*96*3/2*(depth===10?2:1),index=value.sequenceVmaf.index,expected=['reference','distorted'].map(side=>createHash('sha256').update(f.oracles[side].subarray(index*frameBytes,(index+1)*frameBytes)).digest('hex'));
  await viewer.waitForFunction(()=>!!window.__vmafPairHashes);const hashes=await viewer.evaluate(()=>window.__vmafPairHashes);assert.deepEqual(hashes,expected);
  await viewer.locator('#pair-block-selection').selectOption('3');assert.equal((await viewer.evaluate(()=>window.voidPlayerQualityPair.getState())).selectedBlock,3);assert.ok(!requests.some(r=>r.method!=='GET'||/^\/api\/quality\/(jobs|vmaf|ranges)/.test(r.path)));
  await viewer.screenshot({path:path.join(directory,'original-frame.png')});await other.close();viewer=undefined;
  const after=await player.evaluate(()=>window.voidPlayer.getState());assert.deepEqual(after.tracks.map(t=>t.id),before.tracks.map(t=>t.id));assert.ok(after.playing&&after.positionUs>before.positionUs&&after.tracks[0].frame.ptsUs>before.tracks[0].frame.ptsUs);
  phase='late-actor-response';await page.bringToFront();let release,seen=false;const gate=new Promise(r=>release=r);let held=false;
  await page.route(`**/api/quality/vmaf/jobs/${id}`,async route=>{if(!held){held=true;const response=await route.fetch();seen=true;await gate;await route.fulfill({response}).catch(()=>{});}else await route.continue();});await until(()=>seen,Boolean,'Actual late detail response was not observed');
  const peer=await player.evaluate(async()=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'MP4 VMAF peer',mode:'create'})});const v=await r.json();localStorage.setItem('voidplayer.identity',JSON.stringify(v.actor));return v.actor;});
  await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/vmaf/jobs'&&r.request().headers()['x-voidplayer-actor']===peer.id);release();await page.waitForFunction(()=>document.querySelector('#vmaf-detail').hidden&&document.querySelector('#vmaf-title').textContent===''&&document.querySelector('#vmaf-history').textContent==='');assert.equal(await page.locator('#vmaf-plan').inputValue(),'');assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(directory,'history.png'),fullPage:true});const result={containers,job:id,attempt:job.attemptId,frames:summary.vmaf.frames.length,pooled:summary.vmaf.pooled,hashes,work:summary.work,native:summary.vmaf.resources,posts,requests,originalPlayer:{before:before.positionUs,after:after.positionUs},closedObserver:true};reports.push(result);await writeFile(path.join(directory,'evidence.json'),JSON.stringify(result,null,2));
  console.log(`PASS ${engine}/${codec}/${depth} ${containers.join('→')}: GUI discovery/prepare/C/VMAF+PSNR/SSIM, unknown replay, closed observer, shared v2 originals and actor fence`);
 }catch(error){if(page&&!page.isClosed())await saveBrowserFailure({page,directory,name:'mp4-vmaf',context:{engine,codec,depth,containers,phase},error,evidence}).catch(()=>{});throw error;}
 finally{clearInterval(beat);await context?.close();await browser?.close();await f?.close();}
}
