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
  for(const pane of ['overview','library','caches','workspaces','annotations','logs','measurements']){
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
 console.log(`PASS ${engine}: expanded pseudo copy, all seven panels and both certificate OS steps at 1280/720/390/320px`);
});
