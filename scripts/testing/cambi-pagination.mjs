import assert from 'node:assert/strict';
import {cambiFixture} from '../../test/helpers/native-cambi.mjs';
import {until} from '../../test/helpers/native-vmaf.mjs';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';

/** Original response readers witness late completion; no response clone or
 * replacement frame payload. All facts come from a real 10-frame WASM job. */
export async function checkCambiPagination(browser){
 let f,context,page;const holds=[],errors=[];
 try{
  f=await cambiFixture({sequence:true,staticDir:'dist'});
  const created=await f.json('/api/quality/cambi/jobs',{...f.input,interval:{startPtsUs:0,endPtsUs:400000}},'pagination');
  assert.equal((await f.wait(created.job.id)).state,'completed');
  // Fixed source starts at 66733us, cadence 1001/30000: [0,400000) has 10 pictures.
  const summary=await f.json(`/api/quality/cambi/jobs/${created.job.id}/result`);assert.equal(summary.coverage.selected,10);assert.equal(summary.coverage.scored,10);
  context=await browser.newContext();await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  await context.addInitScript(installAdminObservationLifecycle);
  await context.addInitScript(()=>{
   const fetch=window.fetch.bind(window);let sequence=0;window.__cambiPageReads=[];
   window.fetch=async(...args)=>{const id=String(args[0]).includes('/frames?')?++sequence:0;// Deliberately non-cooperative transport: view fencing must survive ignored abort.
   const response=await fetch(args[0],id?{...args[1],signal:undefined}:args[1]);if(!id)return response;const get=response.body.getReader.bind(response.body);
    response.body.getReader=(...args)=>{const reader=get(...args),read=reader.read.bind(reader);reader.read=async(...args)=>{const value=await read(...args);if(value.done)window.__cambiPageReads.push(id);return value;};return reader;};return response;};
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.base+'/admin/?qualityView=cambi#quality');await page.locator(`[data-cambi-job="${created.job.id}"]`).click();await page.locator('[data-cambi-frame="3"]').waitFor();
  await page.route(`**/api/quality/cambi/jobs/${created.job.id}/frames?**`,async route=>{
   if(new URL(route.request().url()).searchParams.get('after')!=='4')return route.continue();
   const response=await route.fetch();let release;const gate=new Promise(r=>release=r);holds.push({release});await gate;await route.fulfill({response});
  });
  const more=page.locator('#cambi-frames-more');await more.click();await until(()=>holds.length,n=>n===1);
  assert.equal(await more.isDisabled(),true,'one original cursor owns the pending advance');await more.evaluate(button=>button.click());assert.equal(holds.length,1);
  // Reselecting the same completed job creates a new view and page owner.
  await page.locator(`[data-cambi-job="${created.job.id}"]`).click();await page.waitForFunction(()=>window.__cambiPageReads.includes(3));await page.locator('[data-cambi-frame="3"]').waitFor();assert.equal(await more.isDisabled(),false);
  await more.click();await until(()=>holds.length,n=>n===2);assert.equal(await more.isDisabled(),true);
  holds[0].release();await page.waitForFunction(()=>window.__cambiPageReads.includes(2));assert.equal(await page.locator('[data-cambi-frame="4"]').count(),0);assert.equal(await more.isDisabled(),true,'old finally cannot unlock the new view request');
  holds[1].release();await page.locator('[data-cambi-frame="7"]').waitFor();assert.equal(await more.isDisabled(),false);
  await more.click();await page.locator('[data-cambi-frame="9"]').waitFor();assert.equal(await more.isHidden(),true);
  const frames=await page.locator('[data-cambi-frame]').evaluateAll(rows=>rows.map(row=>Number(row.dataset.cambiFrame)));assert.deepEqual(frames,Array.from({length:10},(_,i)=>i));assert.deepEqual(errors,[]);
  await drainAdminObservations(page);return {job:created.job.id,frames,heldCursorRequests:holds.length,duplicateClickSuppressed:true,lateViewReplyIgnored:true,newBusyStateRetained:true,pageErrors:errors};
 }finally{for(const hold of holds)hold.release();if(page)await page.unrouteAll({behavior:'wait'});await context?.close();await f?.close();}
}
