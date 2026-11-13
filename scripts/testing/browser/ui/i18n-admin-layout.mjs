import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../../../../server/config.ts';
import {startService} from '../../../../server/runtime.ts';
import {repositoryRoot} from '../../manifest.mjs';
import {withBrowserFixture} from '../../browser-fixture.mjs';
import {chooseTestGuest} from '../../../test-identity.mjs';
const engine=process.argv[2]??'chromium',dist=path.join(repositoryRoot,'.run/i18n-pseudo-dist');
execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',dist],{cwd:repositoryRoot,env:{...process.env,VITE_I18N_PSEUDO:'1'},stdio:'pipe'});
await withBrowserFixture({caseName:'i18n-admin-layout',engine,pageOptions:{viewport:{width:1280,height:900},locale:'en-US',reducedMotion:'reduce'},dependencies:{startService:async({temp,defer})=>{
 const media=path.join(temp,'media');await mkdir(media);await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[{id:'media',name:'User Media',path:media}],staticDir:dist,dataDir:'data',logsDir:'logs',indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;const service=await startService(config);let closed=false;const close=async()=>{if(closed)return;closed=true;await service.close();};defer('partial-service',close);return {...service,close,url:`http://127.0.0.1:${service.server.address().port}/`};
}}},async({page,url,artifact})=>{
 const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'admin?pseudo-locale');await chooseTestGuest(page);assert.match(await page.locator('[data-pane=overview]').innerText(),/［/);
 for(const width of [1280,720,390,320]){
  await page.setViewportSize({width,height:900});
  for(const pane of ['overview','library','caches','annotations','logs','measurements','preferences']){
   // A pane click starts an asynchronous measurement poll. Finish its body
   // before installing routes/navigating: WebKit reports an in-flight request
   // interrupted by navigation as an access-control page error.
   const measurement = pane === 'measurements' ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/measurements') : null;
   await page.locator(`[data-pane=${pane}]`).click();
   if(measurement){const response=await measurement;assert.equal(response.status(),200);assert.equal(await response.finished(),null);}
   await page.waitForTimeout(80);
   const result=await page.locator(`#pane-${pane}`).evaluate(el=>{
    const errors=[],bounds=el.getBoundingClientRect();
    for(const node of el.querySelectorAll('button,input,textarea,h1,h2,dt')){
     if(!node.getClientRects().length)continue;const b=node.getBoundingClientRect(),style=getComputedStyle(node);
     if(b.left<bounds.left-1||b.right>bounds.right+1)errors.push({id:node.id,text:node.textContent,problem:'outside pane',rect:b.toJSON(),bounds:bounds.toJSON()});
     if(node.tagName==='BUTTON'&&style.textOverflow!=='ellipsis'&&node.scrollWidth>node.clientWidth+2)errors.push({id:node.id,text:node.textContent,problem:'clipped text'});
    }
    return {errors,font:getComputedStyle(el).fontFamily,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth};
   });checks.push({width,pane,...result});
   if(width===390&&['library','measurements'].includes(pane)||width===1280&&pane==='overview')await page.screenshot({path:artifact(`admin-pseudo-${pane}-${width}.png`)});
  }
 }
 // Exercise actual wheel chaining and both page selectors with bounded synthetic lists.
 let heldPage, pageStarted;
 const storage = await page.request.get(url + 'api/admin/logs').then(response => response.json());
 await page.route('**/api/admin/logs?*', async route => {
  const params = new URL(route.request().url()).searchParams, pageSize = Number(params.get('pageSize') ?? 40);
  const requested = Number(params.get('page') ?? 1), pages = Math.ceil(85 / pageSize), page = Math.min(requested, pages);
  if (heldPage && requested === 2) { pageStarted(); await heldPage; }
  const entries = Array.from({length: Math.min(pageSize, 85 - (page - 1) * pageSize)}, (_, i) => ({
   name: `voidplayer-log-${85 - (page - 1) * pageSize - i}.json`, size: 2048, receivedAt: '2026-11-04T15:12:25Z', version: 'test',
  }));
  return route.fulfill({json: {...storage, entries, page, pages, total: 85, pageSize}});
 });
 await page.route('**/api/admin/requests?*', async route => {
  const params = new URL(route.request().url()).searchParams, pageSize = Number(params.get('pageSize') ?? 40);
  const requested = Number(params.get('page') ?? 1), pages = Math.ceil(205 / pageSize), page = Math.min(requested, pages);
  if (heldPage && requested === 2) { pageStarted(); await heldPage; }
  const recentRequests = Array.from({length: Math.min(pageSize, 205 - (page - 1) * pageSize)}, (_, i) => ({
   requestId: String(205 - (page - 1) * pageSize - i), t: '2026-11-04T15:12:25Z', actorId: 'local', clientIp: '127.0.0.1',
   method: 'GET', url: '/api/library/browse', status: 200, ms: 2,
  })).reverse();
  return route.fulfill({json: {recentRequests, page, pages, total: 205, pageSize}});
 });
 await page.locator('[data-pane=logs]').click();
 await page.waitForFunction(() => document.querySelectorAll('#log-list button').length === 40);
 for (const mode of ['uploads', 'requests']) {
  await page.locator(`[data-log-mode=${mode}]`).click();
  const rows = mode === 'uploads' ? '#log-list button' : '#request-list .admin-request-row';
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 40, rows);
  let releasePage;
  heldPage = new Promise(resolve => { releasePage = resolve; });
  const started = new Promise(resolve => { pageStarted = resolve; });
  const appearance = () => page.locator('#logs-page-size').evaluate(el => ({opacity: getComputedStyle(el).opacity,
   background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color,
   disabled: el.disabled, text: el.textContent, width: el.getBoundingClientRect().width}));
  const beforePage = await appearance();
  await page.locator('#logs-next').click(); await started;
  try {
   assert.deepEqual(await appearance(), beforePage, 'loading another page does not dim, relabel or resize the page-size selector');
   assert.equal(await page.locator(rows).count(), 40, 'the previous page remains visible until its replacement is ready');
  } finally { releasePage(); heldPage = undefined; }
  await page.waitForFunction(() => document.querySelector('#logs-page').value === '2');
  await page.locator('#logs-page').fill(mode === 'uploads' ? '3' : '6');
  await page.locator('#logs-page').press('Enter');
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 5, rows);
  assert.equal(await page.locator('#logs-next').isDisabled(), true);
  await page.locator('#logs-prev').click();
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 40, rows);
  await page.locator('#logs-page').fill('1'); await page.locator('#logs-page').press('Enter');
  await page.waitForFunction(() => document.querySelector('#logs-prev').disabled);
  for (const width of [1280, 776, 720, 390]) {
   await page.setViewportSize({width, height: 778});
   await page.locator('.admin-content').evaluate(el => { el.scrollTop = 120; });
   const selector = mode === 'uploads' ? '#log-list' : '#requests-view';
   await page.locator(selector).evaluate(el => { el.scrollTop = 0; });
   const box = await page.locator(selector).boundingBox();
   await page.mouse.move(box.x + box.width / 2, Math.max(120, box.y + 30));
   // Chromium latches a wheel sequence to its previous scroll target. Let the
   // prior gesture end after changing viewport size and programmatic positions.
   await page.waitForTimeout(250);
   await page.mouse.wheel(0, -100);
   await page.waitForFunction(() => document.querySelector('.admin-content').scrollTop < 100, null, {timeout: 2000});
   await page.locator('.admin-content').evaluate(el => { el.scrollTop = 0; });
   await page.locator(selector).evaluate(el => { el.scrollTop = el.scrollHeight; });
   const bottom = await page.locator(selector).boundingBox();
   await page.mouse.move(bottom.x + bottom.width / 2, Math.min(700, bottom.y + 30));
   await page.waitForTimeout(250);
   await page.mouse.wheel(0, 100);
   try { await page.waitForFunction(() => document.querySelector('.admin-content').scrollTop > 0, null, {timeout: 2000}); }
   catch (error) {
    const geometry = await page.locator(selector).evaluate(el => {
     const chain = [];
     for (let node = el; node; node = node.parentElement) chain.push({id: node.id, cls: node.className,
      scroll: node.scrollTop, height: node.clientHeight, content: node.scrollHeight,
      overflow: getComputedStyle(node).overflowY, edge: getComputedStyle(node).overscrollBehaviorY});
     return chain;
    });
    throw new Error(`${mode} ${width}px wheel did not reach parent: ${JSON.stringify(geometry)}`, {cause: error});
   }
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
   checks.push({pane: 'log-scroll-' + mode, width, errors: [], wheel: 'both directions', pagination: 'next, previous, jump'});
  }
  for (const size of [20, 100, 40]) {
   await page.locator('#logs-page-size').click();
   await page.locator(`#logs-page-size-menu [data-value="${size}"]`).click();
   const expected = Math.min(size, mode === 'uploads' ? 85 : 205);
   await page.waitForFunction(({selector, expected}) => document.querySelectorAll(selector).length === expected, {selector: rows, expected});
   assert.equal(await page.locator('#logs-page').inputValue(), '1', 'changing page size returns to the first page');
  }
 }
 await page.setViewportSize({width: 776, height: 778});
 await page.locator('.admin-content').evaluate(el => { el.scrollTop = 0; });
 await page.screenshot({path: artifact('admin-log-pagination.png')});
 // Leave the measurement pane so its interval cannot start another poll
 // while the next document is loading. Keep the page-error assertion intact.
 await page.locator('[data-pane=overview]').click();
 await page.route('**/api/connection',r=>r.fulfill({json:{configured:true,httpsUrl:'https://example.test/',certificateUrl:'/api/connection/certificate',fingerprint:'00:AB'}}));
 await page.goto(url+'connection?pseudo-locale');await page.locator('#connection-setup').waitFor({state:'visible'});
 assert.match(await page.locator('#connection-download-title').innerText(),/［/);
 for(const width of [1280,390,320])for(const os of ['windows','macos']){
  await page.setViewportSize({width,height:900});await page.locator(`[data-os=${os}]`).click();
  const result=await page.locator('.connection-guide').evaluate(el=>{
   const bounds=el.getBoundingClientRect(),errors=[];for(const node of el.querySelectorAll('button,a,h2,li')){if(!node.getClientRects().length)continue;const r=node.getBoundingClientRect();if(r.left<bounds.left-1||r.right>bounds.right+1||node.tagName==='BUTTON'&&node.scrollWidth>node.clientWidth+2)errors.push({id:node.id,text:node.textContent,rect:r.toJSON()});}return {errors,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,font:getComputedStyle(el).fontFamily};
  });checks.push({width,pane:'guide-'+os,...result});if(width===390)await page.screenshot({path:artifact(`guide-pseudo-${os}-390.png`)});
 }
 await writeFile(artifact('report.json'),JSON.stringify({engine,checks,errors},null,2));assert.deepEqual(errors,[]);assert.deepEqual(checks.filter(c=>c.errors.length||c.pageWidth>c.viewport+1),[],`expanded pseudo admin/guide controls fit`);
 console.log(`PASS ${engine}: expanded pseudo copy, all administration panels and both certificate OS steps at 1280/720/390/320px`);
});
