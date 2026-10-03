import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../../../../server/config.ts';
import {startService} from '../../../../server/runtime.ts';
import {repositoryRoot} from '../../manifest.mjs';
import {withBrowserFixture} from '../../browser-fixture.mjs';
import {routeInsecureTestOrigin} from '../../http-origin.mjs';
const engine=process.argv[2]??'chromium';
await withBrowserFixture({caseName:'i18n-guide',engine,pageOptions:{viewport:{width:1280,height:800},locale:'en-US',reducedMotion:'reduce'},dependencies:{startService:async({temp,defer})=>{
 const media=path.join(temp,'media');await mkdir(media);
 const config=await loadConfig(['--folder',media,'--data-dir',temp,'--https','voidplayer.test','--host','127.0.0.1','--no-logs'],'production');config.port=0;config.staticDir=path.join(repositoryRoot,'dist');
 const service=await startService(config);let closed=false;const close=async()=>{if(closed)return;closed=true;await service.close();};defer('partial-service',close);
 return {...service,close,server:service.guide,url:`http://voidplayer.test:${service.guide.address().port}/connection?next=${encodeURIComponent('/?workspace=unchanged#review')}`};
}}},async({page,context,url,artifact})=>{
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await routeInsecureTestOrigin(page);await page.goto(url);await page.locator('#connection-setup').waitFor({state:'visible'});
 assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.match(await page.title(),/Certificate/);assert.equal(await page.evaluate(()=>typeof window.voidPlayer),'undefined');
 const peer=await context.newPage();await routeInsecureTestOrigin(peer);await peer.goto(url);
 const locale=async value=>{await peer.evaluate(value=>localStorage.setItem('voidplayer.language',value),value);await page.waitForFunction(value=>document.documentElement.lang===value,value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 await page.locator('[data-os=windows]').click();await page.locator('.connection-fingerprint summary').click();await page.locator('#connection-about summary').click();
 await page.locator('#connection-download').focus();await page.evaluate(()=>{window.__download=document.querySelector('#connection-download');window.__windows=document.querySelector('#connection-windows');window.__target=document.querySelector('#connection-open').href;window.__fingerprint=document.querySelector('#connection-fingerprint').textContent;});
 for(const value of ['zh-CN','en']){await locale(value);assert.deepEqual(await page.evaluate(()=>({download:window.__download===document.querySelector('#connection-download'),windows:window.__windows===document.querySelector('#connection-windows'),focus:document.activeElement===window.__download,os:document.querySelector('[data-os=windows]').getAttribute('aria-pressed'),about:document.querySelector('#connection-about').open,fingerprint:document.querySelector('.connection-fingerprint').open,target:window.__target===document.querySelector('#connection-open').href,digest:window.__fingerprint===document.querySelector('#connection-fingerprint').textContent})),{download:true,windows:true,focus:true,os:'true',about:true,fingerprint:true,target:true,digest:true});}
 assert.match(await page.locator('#connection-windows').innerText(),/Trusted Root Certification Authorities/);await page.screenshot({path:artifact('guide-windows-en.png')});
 await page.locator('[data-os=macos]').click();assert.match(await page.locator('#connection-macos').innerText(),/Keychain Access/);assert.match(await page.locator('#connection-macos').innerText(),/Always Trust/);await page.screenshot({path:artifact('guide-macos-en.png')});
 await page.route('**/api/connection/certificate',r=>r.fulfill({status:500,body:'unavailable'}));await page.locator('#connection-download').click();await page.locator('#connection-download-label').filter({hasText:/Retry/}).waitFor();assert.match(await page.locator('#connection-status').innerText(),/Original cause: HTTP 500/);
 await locale('zh-CN');assert.match(await page.locator('#connection-download-label').innerText(),/重试/);assert.match(await page.locator('#connection-status').innerText(),/原始原因：HTTP 500/);await locale('en');
 await page.unroute('**/api/connection/certificate');
 const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#connection-download').click()]);assert.equal(download.suggestedFilename(),'voidplayer-ca.crt');assert.ok((await readFile(await download.path())).length>0);assert.match(await page.locator('#connection-download-label').innerText(),/again/i);
 // Live unavailable/custom certificate labels, with the same navigation destination.
 await page.route('**/api/connection',r=>r.fulfill({json:{configured:false}}));await page.reload();await page.locator('#connection-unavailable').waitFor({state:'visible'});assert.match(await page.locator('#connection-unavailable').innerText(),/HTTPS/);await locale('zh-CN');assert.match(await page.locator('#connection-unavailable').innerText(),/服务器未开启/);await locale('en');
 await page.unroute('**/api/connection');await page.route('**/api/connection',r=>r.fulfill({json:{configured:true,httpsUrl:'https://voidplayer.test:5180/',certificateUrl:null,fingerprint:null}}));await page.locator('#connection-retry').click();await page.locator('#connection-enter').waitFor({state:'visible'});assert.equal(await page.locator('#connection-setup').isVisible(),false);assert.match(await page.locator('#connection-enter-hint').innerText(),/own certificate/);await locale('zh-CN');assert.match(await page.locator('#connection-enter-hint').innerText(),/自有证书/);await locale('en');
 assert.ok(!requests.some(u=>/\/vendor\/|\/assets\/main-|\/api\/media\//.test(u)),'guide never loads player or codecs');assert.deepEqual(errors,[]);
 await writeFile(artifact('report.json'),JSON.stringify({engine,destination:'preserved',checks:['English initial mount','full Windows and macOS steps','OS/details/focus/node identity','download failure/retry','HTTPS unavailable','custom certificate','no player/decoder imports']},null,2));console.log(`PASS ${engine}: complete bilingual guide, state preservation, real certificate download/retry and HTTPS variants`);
});
