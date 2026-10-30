import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chooseTestGuest} from '../test-identity.mjs';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';

const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
/** Production services and real persisted jobs, with controlled original POST
 * delivery and transient read failures. No throughput or machine-speed gate. */
export async function checkTemporalRecovery(browser,kind,f){
 const contexts=[],releases=[],errors=[],collection=`/api/quality/${kind}/jobs`,storage=`voidplayer-${kind}-pending:${f.actor}`;
 const key='recovery-'+randomUUID(),body=structuredClone(f.input),posts=[];let accepted;
 const context=async(pending,ignorePostAbort=false)=>{
  const c=await browser.newContext();contexts.push(c);await c.addInitScript(installAdminObservationLifecycle);
  await c.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  if(pending)await c.addInitScript(({storage,pending,origin})=>{if(location.origin===origin)sessionStorage.setItem(storage,JSON.stringify(pending));},{storage,pending,origin:f.base});
  if(ignorePostAbort)await c.addInitScript(collection=>{
   const fetch=window.fetch.bind(window);
   window.fetch=(input,options)=>fetch(input,options?.method==='POST'&&String(input)===collection?{...options,signal:undefined}:options);
  },collection);
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
  await list.locator(`#${kind}-refresh`).click();await seen.promise;
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

  // A non-cooperative original POST may deliver a valid receipt after selection changes.
  const late=await context({body,key,attempted:true},true),latePage=await open(late),delivery=gate(),posted=gate();releases.push(delivery.release);
  await latePage.locator(`[data-${kind}-job]`).first().waitFor();
  await latePage.route('**'+collection,async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();posted.release();await delivery.promise;await route.fulfill({response});});
  await latePage.locator(`#${kind}-retry`).click();await posted.promise;
  const other=latePage.locator(`[data-${kind}-job]`).filter({hasNotText:accepted.id}).first(),otherId=await other.getAttribute(`data-${kind}-job`);assert.ok(otherId);
  await other.click();await latePage.locator(`#${kind}-title`).filter({hasText:otherId}).waitFor();delivery.release();
  await latePage.waitForFunction(storage=>JSON.parse(sessionStorage.getItem(storage))?.confirmed===true,storage);
  assert.match(await latePage.locator(`#${kind}-title`).textContent(),new RegExp(otherId));
  await drainAdminObservations(latePage);await late.close();assert.deepEqual(errors,[]);
  return {originalKeyRecoveredAfterActorConflict:true,coalescedSlowHistory:true,completeEvidenceRecovered:true,lateReceiptConfirmedWithoutViewChange:true,pageErrors:errors};
 }finally{for(const release of releases)release();for(const c of contexts)await c.close().catch(()=>{});}
}
