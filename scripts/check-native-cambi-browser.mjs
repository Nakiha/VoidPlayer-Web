import {checkReleasedScoringResult} from './testing/workflow-boundaries.mjs';
import {checkLateQualityReceipt} from './testing/quality-recovery.mjs';
import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';import {chromium,webkit} from 'playwright';
import {installAdminObservationLifecycle,drainAdminObservations} from './testing/admin-observation-lifecycle.mjs';
import {checkAdminIdentityOrder} from './testing/admin-identity-order.mjs';
import {checkCambiPagination} from './testing/cambi-pagination.mjs';
import {checkCambiProgress} from './testing/cambi-progress.mjs';
import {preparationReceiptObserver as postReceiptObserver} from './testing/preparation-receipt.mjs';
import {cambiFixture} from '../test/helpers/native-cambi.mjs';import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';import {chooseTestGuest} from './test-identity.mjs';
const engine=process.argv[2]??'chromium',depth=Number(process.argv[3]??8),container=process.argv[4]??'flv',codec=process.argv[5]??(depth===10?'hevc':'h264'),variant=process.argv[6]??'forward',dir=path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS??`.run/native-cambi/browser-${engine}-${depth}`);await mkdir(dir,{recursive:true});let f,browser,context,page,phase='setup';const errors=[];
try{f=await cambiFixture({depth,container,codec,variant,staticDir:'dist'});browser=await({chromium,webkit}[engine]).launch({headless:true,...(engine==='webkit'&&process.env.VOIDPLAYER_WEBKIT_EXECUTABLE?{executablePath:process.env.VOIDPLAYER_WEBKIT_EXECUTABLE}:{})});context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000}});await context.addInitScript(installAdminObservationLifecycle);await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const player=await context.newPage();await player.goto(f.base);await chooseTestGuest(player);await player.waitForFunction(()=>!!window.voidPlayer);execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=10:duration=120','-c:v','libx264','-preset','ultrafast','-threads','1','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(f.media,'A.mp4')]);await f.service.library.refresh();const [a]=await waitForAnnotationMedia(f.service.library,['A.mp4']);await player.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${f.base}/api/media/${a.id}?v=${a.version}`);await player.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame);await player.evaluate(()=>window.voidPlayer.play());await player.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);const before=await player.evaluate(()=>window.voidPlayer.getState());
 page=await context.newPage();await page.goto(f.base+'/admin/?qualityView=cambi#quality');await page.locator('#quality-cambi').waitFor();await page.locator('[data-cambi-media="'+f.input.source.mediaId+'"]').click();await page.waitForFunction(()=>document.querySelector('#cambi-source').textContent.includes('indexBuildId'));await page.locator('#cambi-start').fill(String(f.input.interval.startPtsUs));await page.locator('#cambi-end').fill(String(f.input.interval.endPtsUs));phase='GUI-submit-lost-response';let lost=false;const posts=[];await page.route('**/api/quality/cambi/jobs',async route=>{if(route.request().method()==='POST'){posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(!lost){lost=true;await route.fetch();await route.abort('failed');return;}}await route.continue();});await page.locator('#cambi-submit').click();await page.locator('#cambi-retry').waitFor({state:'visible'});assert.equal(await page.locator('#cambi-inputs').evaluate(e=>e.disabled),true);const laggedPeer='guest-'+randomUUID();await context.addCookies([{name:'voidplayer-user',value:laggedPeer,url:f.base}]);const mismatch=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/cambi/jobs'&&r.request().method()==='POST'&&r.status()===409);await page.locator('#cambi-retry').click();await mismatch;assert.equal(await page.locator('#cambi-inputs').evaluate(e=>e.disabled),true);const retained=await page.evaluate(actor=>JSON.parse(sessionStorage.getItem('voidplayer-cambi-pending:'+actor)),f.actor);assert.equal(retained.key,posts[0].key);assert.equal(retained.attempted,true);await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);await drainAdminObservations(page);await page.reload();await page.locator('#cambi-retry').waitFor({state:'visible'});await page.locator('#cambi-retry').click();await page.waitForFunction(()=>document.querySelector('#cambi-title').textContent.includes('completed'));assert.equal(posts.length,3);for(const p of posts){assert.equal(posts[0].key,p.key);assert.equal(posts[0].body,p.body);}
 const history=await f.json('/api/quality/cambi/jobs');assert.equal(history.entries.length,1);const job=history.entries[0],summary=await f.json(`/api/quality/cambi/jobs/${job.id}/result`);assert.equal(summary.coverage.scored,4);assert.equal(job.input.source.mediaId,f.input.source.mediaId);assert.equal(job.input.plan,undefined);await page.locator('[data-cambi-frame="0"]').waitFor();phase='candidate-and-true-multiscale-view';const inspect=await context.newPage();await inspect.goto(new URL(await page.locator('[data-cambi-inspect="3"]').getAttribute('href'),f.base).href);await inspect.locator('#cambi-view[data-state="ready"]').waitFor({timeout:30000});assert.match(await inspect.locator('#cambi-view-caption').textContent(),new RegExp(String(f.input.interval.startPtsUs+750000)));await inspect.close();await page.locator('#cambi-text').fill('Explicit GUI banding candidate from original multiscale evidence');await page.locator('#cambi-scale').selectOption('1');await page.locator('#cambi-publish').click();await page.locator('[data-cambi-candidate]').waitFor();const pub=await f.json(`/api/quality/cambi/jobs/${job.id}/candidates`);assert.equal(pub.createdIds.length,1);
 phase='task-center-single-source';const tasks=await context.newPage();await tasks.goto(f.base+'/admin/#tasks');await tasks.locator('#tasks-filters [name="kind"]').selectOption('cambi');await tasks.locator('#tasks-filters [name="metric"]').selectOption('cambi');await tasks.locator('#tasks-filters button[type="submit"]').click();await tasks.locator(`[data-task-kind="cambi"][data-task-id="${job.id}"]`).click();await tasks.waitForFunction(id=>document.querySelector('#tasks-facts').textContent.includes(id),job.id);const taskDetail=await f.json('/api/tasks/cambi/'+job.id);assert.deepEqual(taskDetail.task.metrics,['cambi']);assert.equal(taskDetail.task.sources.length,1);assert.equal(taskDetail.task.sources[0].role,'source');assert.equal(taskDetail.task.attemptId,job.attemptId);assert.deepEqual(taskDetail.related,[]);assert.deepEqual(taskDetail.links.filter(link=>link.rel.startsWith('reexecution')),[{rel:'reexecution-chain',href:`/api/quality/cambi/jobs/${job.id}/reexecutions`}]);assert.equal(await tasks.locator('#tasks-reexecution-unavailable').isHidden(),true);const reexecution=tasks.locator('#tasks-reexecution [data-reexecution="cambi"]');await reexecution.waitFor({state:'visible'});// Capture the original browser POST at the real server, before a navigation
 // can evict Playwright's response-body handle. No second HTTP request, clone
 // or rejected body promise is left awaiting a later click/navigation.
 const previewPath=`/api/quality/cambi/jobs/${job.id}/reexecution-plan`,receipts=postReceiptObserver(15000);
 let releasePreview;
 const capturePreview=(req,res)=>{
  if(req.method!=='POST'||req.url!==previewPath)return;
  const delivery=receipts.claim();if(!delivery)return;
  const end=res.end;
  res.end=function(...args){
   try{
    const value=JSON.parse(String(args[0]));
    const closed=new Promise(resolve=>res.once('close',resolve));
    releasePreview=()=>{releasePreview=undefined;if(res.destroyed)return false;end.apply(res,args);return true;};
    if(!delivery.complete({status:res.statusCode,actor:req.headers['x-voidplayer-actor'],cookie:req.headers.cookie,value,closed})){
     releasePreview=undefined;return end.apply(res,args);
    }
    return res;
   }catch(error){delivery.fail(error);return end.apply(res,args);}
  };
 };
 f.service.server.prependListener('request',capturePreview);
 const capturePlan=async reason=>{
  const observation=receipts.arm();
  const sent=tasks.waitForRequest(r=>new URL(r.url()).pathname===previewPath&&r.method()==='POST',{timeout:15000})
   .then(request=>({ok:true,request}),error=>({ok:false,error}));
  try{
   await reexecution.locator('[data-reason]').fill(reason);await reexecution.locator('[data-plan]').click();
   const outcome=await observation.result;if(!outcome.ok)throw outcome.error;
   const browserPost=await sent;if(!browserPost.ok)throw browserPost.error;
   const receipt=outcome.receipt,request=browserPost.request;
   assert.equal(receipt.status,200);assert.equal(receipt.actor,f.actor);
   assert.equal(request.headers()['x-voidplayer-actor'],receipt.actor);
   assert.equal(receipt.cookie.split(';').map(v=>v.trim()).includes('voidplayer-user='+f.actor),true);
   assert.deepEqual(request.postDataJSON(),{reason});
   assert.equal(receipt.value.schema,'voidplayer-quality-reexecution-plan');
   assert.equal(receipt.value.kind,'cambi');assert.equal(receipt.value.jobId,job.id);assert.equal(receipt.value.reason,reason);
   assert.equal(receipt.value.state,'completed');assert.equal(receipt.value.eligible,false);
   assert.equal(receipt.value.blocks.some(block=>block.code==='original-not-stopped'),true);
   return receipt;
  }finally{observation.close();}
 };
 try{
  phase='completed-preview-delayed-body';
  const receipt=await capturePlan('Completed original remains ineligible'),completedPlan=receipt.value;
  assert.equal(await reexecution.locator('[data-cost]').textContent(),'','server plan is not shown before its original response is delivered');
  assert.equal(await reexecution.locator('[data-execute]').isDisabled(),true);
  assert.equal(releasePreview(),true);
  await reexecution.locator('[data-blocks]').filter({hasText:'original-not-stopped'}).waitFor();
  assert.deepEqual(JSON.parse(await reexecution.locator('[data-cost]').textContent()),completedPlan.cost);
  assert.equal(completedPlan.cost.scope,'entire-frozen-input-from-start');
  assert.equal(completedPlan.cost.selectedPictures,summary.coverage.scored);
  assert.equal(completedPlan.cost.reusesPreviousScores,false);
  assert.equal(await reexecution.locator('[data-execute]').isDisabled(),true);
  phase='completed-preview-navigation-fence';
  const late=await capturePlan('Delayed completed plan must not survive navigation');
  await drainAdminObservations(tasks);await tasks.reload();
  let timer;
  try{await Promise.race([late.closed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Original preview did not close after navigation')),15000))]);}
  finally{clearTimeout(timer);}
  assert.equal(releasePreview(),false,'navigation actually cancelled the held original response');
  await tasks.locator('#tasks-candidates a[href*="cambi=1"]').waitFor();
  await reexecution.waitFor({state:'visible'});
  assert.equal(await reexecution.locator('[data-reason]').inputValue(),'');
  assert.equal(await reexecution.locator('[data-cost]').textContent(),'','late original plan cannot populate the reloaded view');
  assert.equal(await reexecution.locator('[data-execute]').isDisabled(),true);
  assert.equal((await f.json('/api/quality/cambi/jobs')).entries.length,1);
  assert.equal((await f.json(`/api/quality/cambi/jobs/${job.id}/reexecutions`)).successor,null);
  console.log(JSON.stringify({previewReceipt:true,originalBrowserPost:true,status:receipt.status,costMatchesGui:true,delayedBody:true,navigationCancelled:true,latePlanHidden:true}));
 }finally{releasePreview?.();f.service.server.removeListener('request',capturePreview);}
 await tasks.locator('#tasks-candidates a[href*="cambi=1"]').waitFor();const sharedUrl=await tasks.locator('#tasks-candidates a').getAttribute('href');assert.match(sharedUrl,new RegExp(pub.createdIds[0]));assert.equal(await tasks.locator('#tasks-cancel').isVisible(),false);await drainAdminObservations(tasks);await tasks.reload();await tasks.locator('#tasks-candidates a[href*="cambi=1"]').waitFor();assert.equal(await tasks.locator('#tasks-filters [name="kind"]').inputValue(),'cambi');

 const receiptPath=`**/api/quality/cambi/jobs/${job.id}/candidates`;await tasks.route(receiptPath,async route=>{const response=await route.fetch(),value=await response.json();value.selected[0].ref.scale=(value.selected[0].ref.scale+1)%5;await route.fulfill({response,json:value});});await drainAdminObservations(tasks);await tasks.reload();await tasks.locator('#tasks-candidates[data-state="ready"]').waitFor({state:'attached'});assert.equal(await tasks.locator('#tasks-candidates a').count(),0,'entire frame/scale/region ref must match the frozen receipt');await tasks.unroute(receiptPath);await drainAdminObservations(tasks);await tasks.reload();await tasks.locator('#tasks-candidates a[href*="cambi=1"]').waitFor();await drainAdminObservations(tasks);await tasks.close();
 const other=await browser.newContext({viewport:{width:1400,height:900}}),peer='guest-'+randomUUID();await other.addCookies([{name:'voidplayer-user',value:peer,url:f.base}]);const view=await other.newPage(),privateRequests=[];view.on('request',r=>{if(/\/api\/quality\/(?:cambi\/jobs|jobs)/.test(r.url()))privateRequests.push(r.url());});await view.goto(new URL(await page.locator('[data-cambi-candidate]').getAttribute('href'),f.base).href);await view.locator('#cambi-view[data-state="ready"]').waitFor({timeout:30000});const annotation=await f.json('/api/annotations/spaces/default/'+pub.createdIds[0]),e=annotation.document.mark.cambiEvidence[0];assert.equal(e.version,container==='mp4'?2:1);assert.equal(e.value.frame.target.indexIdentity.kind,container);if(container==='mp4')assert.equal(e.value.frame.proof.producer.producer,'server-mp4-scan-v1');for(let scale=0;scale<5;scale++){await view.locator('#cambi-view-scale').selectOption(String(scale));await view.waitForFunction(([scale,sha])=>{const c=document.getElementById('cambi-heatmap');return c.dataset.scale===String(scale)&&c.dataset.sha256===sha;},[scale,e.value.frame.heatmaps[scale].sha256]);}assert.deepEqual(privateRequests,[]);assert.equal((await f.request('/api/quality/cambi/jobs/'+job.id,undefined,undefined,{cookie:'voidplayer-user='+peer,'x-voidplayer-actor':peer})).status,404);
 await view.screenshot({path:path.join(dir,'evidence.png'),fullPage:true});phase='shared-removal-late-fence';let release,seenResolve;const gate=new Promise(r=>release=r),seen=new Promise(r=>seenResolve=r);await view.route('**/api/quality/cambi/shared/**/picture',async route=>{seenResolve();await gate;await route.continue();});await view.reload();await seen;await f.json('/api/annotations/spaces/default',{action:'delete',operationId:randomUUID(),id:annotation.id,revision:annotation.revision},'delete',{'x-voidplayer-action':'annotation'});release();await view.locator('#cambi-view[data-state="failed"]').waitFor();assert.equal(await view.locator('.quality-pair-views').evaluate(e=>e.style.visibility),'hidden');await other.close();
 const after=await player.evaluate(()=>window.voidPlayer.getState());assert.deepEqual(after.tracks.map(t=>t.id),before.tracks.map(t=>t.id));assert.ok(after.positionUs>before.positionUs);assert.ok(after.tracks[0].frame.ptsUs>before.tracks[0].frame.ptsUs);assert.equal(after.tracks[0].sourceGen,before.tracks[0].sourceGen);assert.equal(after.playing,true);assert.deepEqual(errors,[]);
 phase='late-actor-fence';let unhold,heldResolve,held=false;const heldGate=new Promise(r=>unhold=r),heldSeen=new Promise(r=>heldResolve=r);await page.route(`**/api/quality/cambi/jobs/${job.id}`,async route=>{if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch();heldResolve();await heldGate;await route.fulfill({response}).catch(()=>{});}else await route.continue();});await heldSeen;
 const newActor=await player.evaluate(async()=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'CAMBI peer',mode:'create'})});const v=await r.json();localStorage.setItem('voidplayer.identity',JSON.stringify(v.actor));return v.actor;});await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/cambi/jobs'&&r.request().headers()['x-voidplayer-actor']===newActor.id);unhold();await page.waitForFunction(()=>document.querySelector('#cambi-detail').hidden&&document.querySelector('#cambi-title').textContent===''&&document.querySelector('#cambi-history').textContent==='');assert.equal(await page.locator('#cambi-source').textContent(),'');
 // The identity-change response above must remain fenced before observers stop.
 await drainAdminObservations(page);assert.deepEqual(errors,[]);
 // A real cross-origin failure still reaches the browser's page-error collector.
 // Its expected error lives in a separate context, never filtered from this flow.
 if(engine==='webkit'){
  const control=await browser.newContext(),failures=[];await control.addInitScript(installAdminObservationLifecycle);const probe=await control.newPage();probe.on('pageerror',e=>failures.push(e.message));
  try{
   await probe.goto(f.base+'/admin/#overview');await probe.locator('[data-pane=overview]').waitFor();await drainAdminObservations(probe);assert.deepEqual(failures,[]);
   const crossOrigin=f.base.replace('127.0.0.1','localhost')+'/api/health?cors-negative-control=1',real=await fetch(crossOrigin);assert.equal(real.status,200);assert.equal(real.headers.get('access-control-allow-origin'),null);await real.arrayBuffer();
   const observed=probe.waitForEvent('pageerror',{predicate:e=>e.message.includes('localhost')&&e.message.includes('access control checks'),timeout:15000}).then(error=>({ok:true,error:error.message}),error=>({ok:false,error}));
   const result=await probe.evaluate(async url=>{try{await fetch(url);return {rejected:false};}catch(error){return {rejected:true,name:error.name};}},crossOrigin);assert.equal(result.rejected,true);assert.equal(result.name,'TypeError');const rejected=await observed;if(!rejected.ok)throw rejected.error;assert.ok(failures.includes(rejected.error));
  }finally{await control.close();}
 }
 phase='cross-window-release';if(depth===8&&container==='flv')await checkReleasedScoringResult(browser,'cambi',f);
 phase='late-submit-receipt';const lateSubmission=depth===8&&container==='flv'?await checkLateQualityReceipt(browser,'cambi',f,{body:JSON.parse(posts[0].body),key:posts[0].key,jobId:job.id}):null;
 phase='cambi-progress-and-partial';const progress=depth===8&&container==='flv'?await checkCambiProgress(browser,engine):null;
 phase='cambi-pagination-ownership';const pagination=depth===8&&container==='flv'?await checkCambiPagination(browser):null;
 phase='confirmed-identity-late-storage';const identityOrder=depth===8&&container==='flv'?await checkAdminIdentityOrder(browser,f):null;
 assert.deepEqual(errors,[]);await writeFile(path.join(dir,'results.json'),JSON.stringify({engine,depth,container,codec,variant,lateSubmission,pagination,identityOrder,progress,job:job.id,attemptId:job.attemptId,coverage:summary.coverage,resources:summary.resources,output:summary.output,posts,originalPlaybackProgressed:true,allFiveOfficialScales:true,sharedNoPrivateJobFetch:true,adminReadersDrained:true,realCorsNegativeControl:engine==='webkit',pageErrors:errors},null,2));console.log(`PASS ${engine} ${depth}/${container}/${codec}/${variant}: actual GUI single-source submit, lost-response replay, official5-scale evidence/source snapshot, shared candidate, actor/removal fences, original playback continues`);
}catch(error){await writeFile(path.join(dir,'failure.json'),JSON.stringify({phase,error:String(error),errors,status:await page?.locator('#cambi-status').textContent().catch(()=>null)},null,2));if(page)await page.screenshot({path:path.join(dir,'failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{await context?.close();await browser?.close();await f?.close();}
