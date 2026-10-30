import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installAdminObservationLifecycle,drainAdminObservations} from './admin-observation-lifecycle.mjs';

/** Real release writes with a delayed original response, never a cloned body or
 * a second request. Late replies must not own a new target's control state. */
export async function checkTaskResultRelease(browser,f) {
  const jobs=[];
  for(let i=0;i<4;i++){
    const job=(await f.json('/api/quality/vmaf/jobs',f.input,'release-browser-'+i)).job;
    assert.equal((await f.wait(job.id)).state,'completed');jobs.push(job.id);
  }
  const context=await browser.newContext({viewport:{width:1280,height:900}}),errors=[],writes=[];
  await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);
  await context.addInitScript(installAdminObservationLifecycle);
  await context.addInitScript(()=>{
    const fetch=window.fetch.bind(window);window.__releaseHolds=new Map();window.__releaseConsumed=[];
    window.fetch=async(input,options)=>{
      const pathname=new URL(String(input),location.href).pathname;
      if(options?.method!=='POST'||!pathname.endsWith('/release-result')||!window.__holdReleases)return fetch(input,options);
      options={...options};delete options.signal;
      const response=await fetch(input,options);
      await new Promise(resolve=>window.__releaseHolds.set(pathname,{resolve,status:response.status}));
      const get=response.body.getReader.bind(response.body);response.body.getReader=(...args)=>{
        const reader=get(...args),read=reader.read.bind(reader);
        reader.read=async(...args)=>{const value=await read(...args);if(value.done)window.__releaseConsumed.push(pathname);return value;};return reader;
      };
      return response;
    };
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  const route=id=>`/api/tasks/vmaf/${id}/release-result`;
  const choose=async id=>{await page.locator(`[data-task-id="${id}"]`).click();await page.waitForFunction(id=>document.querySelector('#tasks-title').textContent.includes(id),id);};
  const held=async id=>{await page.waitForFunction(p=>window.__releaseHolds.has(p),route(id));assert.equal(await page.evaluate(p=>window.__releaseHolds.get(p).status,route(id)),200);};
  const release=async id=>{await page.evaluate(p=>window.__releaseHolds.get(p).resolve(),route(id));await page.waitForFunction(p=>window.__releaseConsumed.includes(p),route(id));};
  try{
    await page.goto(f.base+'/admin/#tasks');await page.evaluate(()=>window.__holdReleases=true);
    await choose(jobs[0]);await page.locator('#tasks-release').click();await held(jobs[0]);
    await choose(jobs[1]);assert.equal(await page.locator('#tasks-release').isEnabled(),true,'new task clears previous release busy state');
    await page.locator('#tasks-release').click();await held(jobs[1]);await release(jobs[0]);
    assert.equal(await page.locator('#tasks-release').isDisabled(),true,'late old receipt cannot enable the new pending release');
    await release(jobs[1]);await page.waitForFunction(()=>document.querySelector('#tasks-release').hidden);
    for(const id of jobs.slice(0,2))assert.equal((await f.json(`/api/tasks/vmaf/${id}`)).task.result.available,false);

    await choose(jobs[2]);await page.locator('#tasks-release').click();await held(jobs[2]);
    const peer='guest-'+randomUUID();await context.addCookies([{name:'voidplayer-user',value:peer,url:f.base}]);
    await page.evaluate(value=>{localStorage.setItem('voidplayer.identity',JSON.stringify({id:value,name:'Peer'}));window.dispatchEvent(new StorageEvent('storage',{key:'voidplayer.identity'}));},peer);
    await page.waitForFunction(()=>document.querySelector('#tasks-detail').hidden&&document.querySelectorAll('[data-task-id]').length===0);
    await release(jobs[2]);assert.equal(await page.locator('#tasks-facts').textContent(),'','late release cannot repopulate another actor');
    await context.addCookies([{name:'voidplayer-user',value:f.actor,url:f.base}]);await drainAdminObservations(page);await page.reload();
    await choose(jobs[3]);assert.equal(await page.locator('#tasks-release').isEnabled(),true,'restored owner gets an enabled control for a fresh task');
    await page.locator('#tasks-release').click();await page.waitForFunction(()=>document.querySelector('#tasks-release').hidden);
    assert.equal((await f.json(`/api/tasks/vmaf/${jobs[3]}`)).task.result.available,false);
    assert.deepEqual(writes,jobs.map(route),'exactly one real release per explicit click');assert.deepEqual(errors,[]);
    await drainAdminObservations(page);
    return {jobs,lateTargetReceiptFenced:true,lateActorReceiptFenced:true,secondOperationRemainsBusy:true,writes};
  }finally{
    await page.evaluate(()=>{for(const gate of window.__releaseHolds?.values()??[])gate.resolve();}).catch(()=>{});
    await context.close();
  }
}
