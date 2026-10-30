import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {until} from '../../test/helpers/native-vmaf.mjs';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';

/** Delay delivery of the real peer storage notification until /health already
 * confirms its cookie. HTTP identity/job/observation responses stay genuine. */
export async function checkAdminIdentityOrder(browser,f){
 const context=await browser.newContext(),errors=[],history=[];let page;
 try{
  await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  await context.addInitScript(installAdminObservationLifecycle);
  await context.addInitScript(()=>{
   const add=window.addEventListener.bind(window),queued=[];
   window.addEventListener=(type,listener,options)=>add(type,type==='storage'?event=>queued.push(()=>typeof listener==='function'?listener.call(window,event):listener.handleEvent(event)):listener,options);
   window.__identityOrder={pending:()=>queued.length,release(){const count=queued.length;for(const run of queued.splice(0))run();return count;}};
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',req=>{if(new URL(req.url()).pathname==='/api/quality/cambi/jobs')history.push(req.headers()['x-voidplayer-actor']);});
  const entered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/cambi/jobs');
  await page.goto(f.base+'/admin/?qualityView=cambi#quality');await entered;
  const peer=await context.newPage();await peer.goto(f.base+'/api/health');
  const actor=await peer.evaluate(async name=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name,mode:'create'})});if(!r.ok)throw Error(await r.text());const {actor}=await r.json();localStorage.setItem('voidplayer.identity',JSON.stringify(actor));return actor;},'Identity order '+randomUUID());
  const headers={cookie:'voidplayer-user='+actor.id,'x-voidplayer-actor':actor.id};
  const created=await f.json('/api/quality/cambi/jobs',f.input,'identity-order-'+randomUUID(),headers);
  await until(()=>f.json('/api/quality/cambi/jobs/'+created.job.id,undefined,undefined,headers),job=>job.state==='completed');
  await page.waitForFunction(()=>window.__identityOrder.pending()>0);
  const focused=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/health');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await focused;
  const button=page.locator(`[data-cambi-job="${created.job.id}"]`);await button.waitFor();
  const confirmed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/health');
  const deliveries=await page.evaluate(()=>window.__identityOrder.release());assert.ok(deliveries>0);await confirmed;await button.waitFor();
  assert.ok(history.includes(actor.id));assert.ok(!history.includes(''),'pending confirmation never sends an empty captured actor');
  const secondConfirmation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/health');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await secondConfirmation;assert.equal(await button.count(),1);
  const stored=await f.json('/api/quality/cambi/jobs/'+created.job.id,undefined,undefined,headers);assert.equal(stored.actor.id,actor.id);assert.deepEqual(errors,[]);
  await drainAdminObservations(page);
  return {job:created.job.id,lateStorageAfterConfirmedActor:true,historyRestoredWithoutReload:true,emptyActorRequests:0,storageDeliveries:deliveries,pageErrors:errors};
 }finally{await context.close();}
}
