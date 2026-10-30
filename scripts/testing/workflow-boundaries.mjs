import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function ownedContext(browser,f){
 const c=await browser.newContext({locale:'en-US'});await c.addInitScript(installAdminObservationLifecycle);
 await c.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);return c;
}
export async function checkReleasedScoringResult(browser,kind,f){
 const collection=`/api/quality/${kind}/jobs`,accepted=await f.json(collection,f.input,'release-regression-'+randomUUID());
 const job=await f.wait(accepted.job.id);assert.equal(job.state,'completed');assert.equal(job.resultRetained,true);
 const c=await ownedContext(browser,f);let p,peer;
 try{
  p=await c.newPage();peer=await c.newPage();let other;
  if(kind==='xpsnr')other=await f.wait((await f.json(collection,f.input,'comparison-release-'+randomUUID())).job.id);
  await p.goto(f.base+`/admin/?qualityView=${kind}#quality`);
  // The private history may already span several pages; select through the real URL-independent controller row.
  await p.route('**'+collection+'?**',r=>r.fulfill({json:{entries:other?[job,other]:[job],after:1,more:false}}));
  await p.locator(`#${kind}-refresh`).click();await p.locator(`[data-${kind}-job="${job.id}"]`).click();
  await p.locator(`[data-${kind}-frame="0"]`).waitFor();assert.equal(await p.locator(`#${kind}-publish`).isDisabled(),false);
  if(other){
   for(const id of [job.id,other.id])await p.locator(`[data-xpsnr-compare="${id}"]`).check();
   await p.locator('#xpsnr-compare').click();await p.locator('#xpsnr-comparison-panel[data-state="ready"]').waitFor();
  }
  await peer.goto(f.base+'/admin/#tasks');
  const released=await peer.evaluate(async({kind,id})=>{const r=await fetch(`/api/tasks/${kind}/${id}/release-result`,{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'quality-job'},body:'{}'});return {status:r.status,value:await r.json()};},{kind,id:job.id});
  assert.equal(released.status,200,JSON.stringify(released));
  const after=await f.json(collection+'/'+job.id);assert.equal(after.resultRetained,false);assert.ok(after.revision>job.revision);assert.equal(after.resultDigest,job.resultDigest);assert.equal(after.attemptId,job.attemptId);
  await p.locator(`#${kind}-refresh`).click();await p.waitForFunction(kind=>document.getElementById(kind+'-publish').disabled&&document.querySelectorAll('[data-'+kind+'-frame]').length===0,kind);
  assert.equal(await p.locator(`#${kind}-summary dd`).count(),0);assert.match(await p.locator(`#${kind}-summary`).textContent(),/released|回收/);assert.equal(await p.locator(`#${kind}-frames-more`).isHidden(),true);
  assert.equal((await f.request(collection+'/'+job.id+'/result')).status,409);
  if(other){assert.equal(await p.locator('#xpsnr-comparison-content').isHidden(),true);assert.equal(await p.locator('#xpsnr-comparison-selection > div').count(),2,'unavailable results retain the original pinned comparison selection');}
  return {revisionAdvanced:true,digestRetained:true,staleFramesCleared:true,publicationDisabled:true};
 }finally{if(p)await drainAdminObservations(p);if(peer)await drainAdminObservations(peer);await c.close();}
}
export async function checkCorrespondenceReceipts(browser,f){
 const c=await ownedContext(browser,f),p=await c.newPage(),delivery=gate(),seen=gate();
 const storage=`voidplayer-clock-pending:${f.actor}:plan`,key='plan-receipt-'+randomUUID(),body=f.planInput,posts=[];
 try{
  await p.goto(f.base+'/admin/?qualityView=correspondence#quality');
  await p.evaluate(({storage,body,key})=>sessionStorage.setItem(storage,JSON.stringify({key,body:JSON.stringify(body)})),{storage,body,key});
  await drainAdminObservations(p);await p.reload();
  let mode='malformed';
  await p.route('**/api/quality/correspondence-plans',async route=>{
   if(route.request().method()!=='POST')return route.continue();posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
   if(mode==='malformed')return route.fulfill({json:{}});
   const response=await route.fetch();assert.ok(response.ok());seen.release();await delivery.promise;await route.fulfill({response});
  });
  await p.locator('#quality-clock-retry-plan').click();await p.locator('#quality-clock-status').filter({hasText:'acknowledgement'}).waitFor();
  let saved=await p.evaluate(k=>JSON.parse(sessionStorage.getItem(k)),storage);assert.equal(saved.confirmed,undefined);assert.equal(saved.key,key);assert.equal(await p.locator('#quality-clock-plan-submit').isDisabled(),true);
  mode='valid';await p.locator('#quality-clock-retry-plan').click();await seen.promise;
  await p.locator(`[data-clock-plan="${f.input.plan.id}"]`).click();await p.locator('#quality-clock-title').filter({hasText:f.input.plan.id}).waitFor();delivery.release();
  await p.waitForFunction(k=>JSON.parse(sessionStorage.getItem(k)).confirmed,storage);
  await p.waitForFunction(()=>!document.getElementById('quality-clock-plan-submit').disabled);
  assert.equal(await p.locator('#quality-clock-pending-plan').isHidden(),true);assert.match(await p.locator('#quality-clock-title').textContent(),new RegExp(f.input.plan.id));assert.deepEqual(posts[0],posts[1]);
  return {malformedReceiptRetainsKey:true,lateReceiptUnlocksOwnerWithoutChangingSelection:true};
 }finally{delivery.release();await drainAdminObservations(p);await c.close();}
}
export async function checkPreparationReceipts(browser,f){
 const c=await ownedContext(browser,f),p=await c.newPage(),delivery=gate(),seen=gate(),source={id:f.entries[0].id,version:f.entries[0].version},posts=[];
 const jobs=[0,1].map(()=>({id:randomUUID(),state:'running',input:{source,operation:'probe',client:{id:'regression',name:'Regression'}},result:null}));
 try{
  await p.route('**/api/library/preparations**',async route=>{
   const url=new URL(route.request().url());
   if(route.request().method()==='POST'){
    if(url.pathname.endsWith('/cancel')){seen.release();await delivery.promise;jobs[0].state='cancelled';return route.fulfill({json:jobs[0]});}
    posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});return route.fulfill({json:{}});
   }
   const id=url.pathname.split('/').at(-1);return route.fulfill({json:id==='preparations'?{jobs,next:null}:jobs.find(j=>j.id===id)});
  });
  await p.goto(f.base+'/admin/#discovery');await p.locator(`[data-job-id="${jobs[0].id}"]`).click();await p.locator('#discovery-cancel').click();await seen.promise;
  await p.locator(`[data-job-id="${jobs[1].id}"]`).click();await p.waitForFunction(id=>document.getElementById('discovery-job').textContent.includes(id),jobs[1].id);delivery.release();
  await p.locator('#discovery-refresh-jobs').click();await p.waitForFunction(id=>document.getElementById('discovery-job').textContent.includes(id),jobs[1].id);
  await p.locator('[data-source-id]').first().click();await p.locator('#discovery-probe').click();await p.locator('#discovery-job-status').filter({hasText:'acknowledgement'}).waitFor();
  assert.equal(await p.locator('#discovery-probe').isDisabled(),true);await p.locator('#discovery-retry').click();await p.waitForFunction(()=>!document.getElementById('discovery-retry').disabled);
  assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);
  const saved=await p.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('voidplayer-library-preparation:')).map(k=>JSON.parse(sessionStorage.getItem(k))));assert.equal(saved.length,1);assert.equal(saved[0].key,posts[0].key);assert.equal(saved[0].confirmed,undefined);
  return {lateCancelPreservesSelection:true,malformedReceiptRetainsFrozenSubmission:true};
 }finally{delivery.release();await drainAdminObservations(p);await c.close();}
}

export async function checkCandidateWorkspaceRoundtrip(browser,f,annotation){
 const {Viewport}=await import('../../shared/presentation/viewport.ts');
 const {parseWorkspace}=await import('../../shared/review/workspace-file.ts');
 const mark=annotation.document.mark,media=annotation.document.media;
 const tracks=[{slot:mark.slot,mediaId:mark.mediaId,offsetUs:0},...mark.comparison.map(c=>({slot:c.slot,mediaId:c.mediaId,offsetUs:0}))];
 const document=parseWorkspace({schema:'voidplayer-workspace',version:3,name:'Candidate roundtrip',generatedAt:new Date().toISOString(),serverUrl:f.base,positionUs:0,tracks,media,marks:[mark],viewport:new Viewport().snapshot()});
 const shared=await f.json('/api/workspaces/share',{name:document.name,document},undefined,{'x-voidplayer-action':'workspace'});
 const first=await f.json('/api/workspaces/'+shared.id);assert.equal(first.document.version,1);assert.equal(first.document.marks.length,0);parseWorkspace(first.document);
 const seeds=await f.json('/api/annotations/spaces/'+first.space);assert.equal(seeds.entries.length,1);assert.ok(seeds.entries[0].document.mark.qualityCandidate);
 const c=await ownedContext(browser,f),p=await c.newPage();
 try{
  await p.goto(f.base+'/?workspace='+shared.id);
  await p.waitForFunction(()=>{const s=window.voidPlayer?.getState();if(s?.tracks.some(t=>t.failure))throw Error(JSON.stringify(s.tracks));return s&&!s.busy&&s.tracks.length===2&&s.tracks.every(t=>t.frame)&&s.marks.length===1;});
  const updated=await p.evaluate(async({id,revision,document})=>{const r=await fetch('/api/workspaces/'+id,{method:'PUT',headers:{'content-type':'application/json','x-voidplayer-action':'workspace','if-match':JSON.stringify(String(revision))},body:JSON.stringify({name:'Updated candidate workspace',document})});return {status:r.status,value:await r.json()};},{id:shared.id,revision:first.revision,document:first.document});
  assert.equal(updated.status,200,JSON.stringify(updated));parseWorkspace((await f.json('/api/workspaces/'+shared.id)).document);
  await p.reload();await p.waitForFunction(()=>{const s=window.voidPlayer?.getState();return s&&!s.busy&&s.tracks.length===2&&s.marks.length===1;});
  return {baseVersion:1,seedRetained:true,realPlayerRestored:true,savedAndReopened:true};
 }finally{await c.close();}
}
