import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chooseTestGuest} from '../test-identity.mjs';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';

async function bounded(promise,label){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Recovery gate did not complete: '+label)),15000);})]);}finally{clearTimeout(timer);}
}
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
/** Production services and real persisted jobs, with controlled original POST
 * delivery and transient read failures. No throughput or machine-speed gate. */
export async function checkTemporalRecovery(browser,kind,f){
 const contexts=[],releases=[],errors=[],collection=`/api/quality/${kind}/jobs`,storage=`voidplayer-${kind}-pending:${f.actor}`;
 const key='recovery-'+randomUUID(),body=structuredClone(f.input),posts=[];let accepted;
 const context=async(pending)=>{
  const c=await browser.newContext();contexts.push(c);await c.addInitScript(installAdminObservationLifecycle);
  await c.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  if(pending)await c.addInitScript(({storage,pending,origin})=>{if(location.origin===origin)sessionStorage.setItem(storage,JSON.stringify(pending));},{storage,pending,origin:f.base});
  return c;
 };
 const open=async c=>{const p=await c.newPage();p.setDefaultTimeout(15000);await p.goto(f.base+`/admin/?qualityView=${kind}#quality`);await chooseTestGuest(p);return p;};
 try{
  const c=await context({body,key,attempted:false});let lost=false;
  await c.route('**'+collection,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
   if(!lost){lost=true;const response=await route.fetch();assert.ok(response.ok());accepted=(await response.json()).job;return route.abort('failed');}
   await route.continue();
  });
  const p=await open(c);await p.locator(`#${kind}-retry`).click();
  await p.waitForFunction(({kind,storage})=>!!JSON.parse(sessionStorage.getItem(storage))?.attempted&&!!document.getElementById(kind+'-status').textContent,{kind,storage});
  assert.equal(await p.locator(`#${kind}-submit`).isDisabled(),true);
  await c.addCookies([{name:'voidplayer-user',value:'guest-'+randomUUID(),url:f.base}]);
  const rejected=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===collection);
  await p.locator(`#${kind}-retry`).click();const rejection=await rejected;assert.equal(rejection.status(),409);assert.equal((await rejection.json()).code,'actor-changed');
  await p.waitForFunction(({kind})=>document.getElementById(kind+'-status').textContent.includes('identity')||document.getElementById(kind+'-status').textContent.includes('身份')||document.getElementById(kind+'-status').textContent.includes('actor'),{kind});
  const retained=await p.evaluate(storage=>JSON.parse(sessionStorage.getItem(storage)),storage);assert.equal(retained.key,key);assert.equal(retained.confirmed,undefined);assert.equal(await p.locator(`#${kind}-submit`).isDisabled(),true);
  await c.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);await p.locator(`#${kind}-retry`).click();
  await p.waitForFunction(storage=>JSON.parse(sessionStorage.getItem(storage))?.confirmed===true,storage);
  await p.locator(`#${kind}-title`).filter({hasText:accepted.id}).waitFor();
  assert.equal(posts.length,3);assert.deepEqual(posts[0],posts[1]);assert.deepEqual(posts[1],posts[2]);
  await drainAdminObservations(p);await c.close();

  // A response held through repeated refreshes must be consumed, not invalidated.
  const slow=await context(),list=await open(slow);await list.locator(`[data-${kind}-job]`).first().waitFor();
  const held=gate(),seen=gate();releases.push(held.release);let reads=0;
  await list.route('**'+collection+'?**',async route=>{reads++;seen.release();if(reads===1)await held.promise;await route.fulfill({json:{entries:[accepted],after:1,more:false}});});
  await list.locator(`#${kind}-refresh`).click();await bounded(seen.promise,'slow history entered');
  for(let n=0;n<3;n++)await list.locator(`#${kind}-refresh`).click();assert.equal(reads,1,'same-scope refreshes share the in-flight history read');
  held.release();await list.waitForFunction(({kind,id})=>{const rows=[...document.querySelectorAll('[data-'+kind+'-job]')];return rows.length===1&&rows[0].dataset[kind+'Job']===id;},{kind,id:accepted.id});
  await drainAdminObservations(list);await slow.close();

  const done=await f.wait(accepted.id);assert.equal(done.state,'completed');
  const publication=await f.json(`${collection}/${accepted.id}/candidates`,{space:'default',side:'reference',maxScore:100,limit:2,minFrameDistance:1,text:'Recovery evidence',severity:3});
  assert.equal(publication.createdIds.length,2);
  const evidence=await context(),view=await open(evidence);let failed=false,annotationReads=0;
  const retry=gate();releases.push(retry.release);
  await view.route(`**/api/annotations/spaces/default/${publication.createdIds[1]}`,async route=>{
   annotationReads++;if(!failed){failed=true;return route.fulfill({status:503,json:{error:'Recovery test transient annotation failure',code:'recovery-transient'}});}
   await retry.promise;await route.continue();
  });
  // The new job can lie beyond the first history page in XPSNR's pagination test.
  await view.route('**'+collection+'?**',route=>route.fulfill({json:{entries:[done],after:1,more:false}}));
  await view.locator(`#${kind}-refresh`).click();await view.locator(`[data-${kind}-job="${accepted.id}"]`).click();
  await view.locator(`#${kind}-status`).filter({hasText:'Recovery test transient'}).waitFor();
  assert.equal(await view.locator(`[data-${kind}-candidate]`).count(),0,'a failed second annotation cannot leave a partial link set');
  await view.locator(`#${kind}-refresh`).click();retry.release();
  await view.waitForFunction(kind=>document.querySelectorAll('[data-'+kind+'-candidate]').length===2,kind);assert.ok(annotationReads>=2);
  await drainAdminObservations(view);await evidence.close();

  await checkLateQualityReceipt(browser,kind,f,{body,key,jobId:accepted.id});assert.deepEqual(errors,[]);
  return {originalKeyRecoveredAfterActorConflict:true,coalescedSlowHistory:true,completeEvidenceRecovered:true,lateReceiptConfirmedWithoutViewChange:true,pageErrors:errors};
 }finally{for(const release of releases)release();for(const c of contexts)await c.close().catch(()=>{});}
}


/** A valid late receipt settles actor-owned controls without navigating away
 * from the task selected meanwhile. Uses original production response bytes. */
export async function checkLateQualityReceipt(browser,kind,f,{body,key,jobId}){
 const collection=`/api/quality/${kind}/jobs`,storage=`voidplayer-${kind}-pending:${f.actor}`,errors=[];
 const history=await f.json(collection);let other=history.entries.find(j=>j.id!==jobId);
 if(!other)other=(await f.json(collection,body,'late-other-'+randomUUID())).job;
 other=await f.wait(other.id);
 const c=await browser.newContext(),delivery=gate(),posted=gate();let page;
 try{
  await c.addInitScript(installAdminObservationLifecycle);await c.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await c.addInitScript(({storage,pending,origin,collection})=>{
   if(location.origin===origin)sessionStorage.setItem(storage,JSON.stringify(pending));
   const fetch=window.fetch.bind(window);window.fetch=(input,options)=>fetch(input,options?.method==='POST'&&String(input)===collection?{...options,signal:undefined}:options);
  },{storage,pending:{body,key,attempted:true},origin:f.base,collection});
  page=await c.newPage();page.setDefaultTimeout(15000);
  await page.route('**'+collection+'?**',route=>route.fulfill({json:{entries:[other],after:1,more:false}}));
  await page.goto(f.base+`/admin/?qualityView=${kind}#quality`);await chooseTestGuest(page);
  await page.locator(`[data-${kind}-job="${other.id}"]`).waitFor();
  await page.route('**'+collection,async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();assert.equal((await response.json()).job.id,jobId);posted.release();await delivery.promise;await route.fulfill({response});});
  await page.locator(`#${kind}-retry`).click();await bounded(posted.promise,'late replay entered');
  await page.locator(`[data-${kind}-job="${other.id}"]`).click();await page.locator(`#${kind}-title`).filter({hasText:other.id}).waitFor();delivery.release();
  await page.waitForFunction(({storage,kind})=>JSON.parse(sessionStorage.getItem(storage))?.confirmed===true&&!document.getElementById(kind+'-submit').disabled&&document.getElementById(kind+'-retry').hidden,{storage,kind});
  assert.match(await page.locator(`#${kind}-title`).textContent(),new RegExp(other.id));
  await drainAdminObservations(page);assert.deepEqual(errors,[]);
  return {lateReceiptConfirmedWithoutViewChange:true,submissionControlsRecovered:true,pageErrors:errors};
 }finally{delivery.release();await c.close();}
}
