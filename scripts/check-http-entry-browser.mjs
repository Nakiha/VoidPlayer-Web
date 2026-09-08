import { chooseTestGuest } from './test-identity.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
const address=Object.values(os.networkInterfaces()).flat().find(i=>i && i.family==='IPv4' && !i.internal)?.address;if(!address)throw new Error('HTTP entry regression requires a non-loopback IPv4 interface');
const root=path.resolve(import.meta.dirname,'..'),temp=await mkdtemp(path.join(os.tmpdir(),'vp-http-entry-')),name=process.argv[2]??'chromium';
let service,browser;
try{
 await mkdir(path.join(temp,'media'));await writeFile(path.join(temp,'media','clip.mp4'),'0123456789');
 const config=await loadConfig(['--folder',path.join(temp,'media'),'--data-dir',path.join(temp,'data'),'--https',address,'--host',address,'--no-logs'],'production',root);config.port=0;service=await startService(config);await service.library.refresh();
 const port=service.server.address().port,alias=service.guide.address().port,secure=`https://${address}:${port}`,remote=`http://${address}:${port}`;
 browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-proxy-server']}:{})});
 async function pageFor(accepted){
  // HTTPS acceptance is scoped to this disposable browser context, never the user's trust store.
  const context=await browser.newContext({ignoreHTTPSErrors:accepted,viewport:{width:1512,height:800},colorScheme:'dark'}),page=await context.newPage();

  return {context,page};
 }
 const {page,context}=await pageFor(false),errors=[];page.on('pageerror',e=>errors.push(e.message));const requests=[];page.on('request',r=>requests.push(r.url()));
 const original='/?source=sample%20name&mode=compare#frame-12';
 await page.goto(remote+original);await page.locator('#connection-setup').waitFor();
 assert.equal(await page.evaluate(()=>isSecureContext),false);assert.equal(await page.evaluate(()=>typeof window.voidPlayer),'undefined');
 assert.equal(new URL(page.url()).pathname,'/connection');assert.equal(new URL(page.url()).searchParams.get('next'),original);
 assert.equal(await page.locator('#connection-open').getAttribute('href'),secure+original);
 assert.ok(!requests.some(url=>/\/assets\/main-|\/vendor\//.test(url)),'untrusted entry does not load the player or WASM');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),'failed-check guide fits a laptop');
 await page.screenshot({path:`/tmp/voidplayer-http-untrusted-${name}.png`});
 await page.locator('#connection-open').click();await page.locator('#connection-status').filter({hasText:'暂时无法'}).waitFor();assert.equal(new URL(page.url()).protocol,'http:');
 // A fresh HTTP tab still serves management and machine-readable data without trust.
 const admin=await context.newPage();
 await admin.goto(remote+'/admin#caches');await chooseTestGuest(admin);await admin.locator('#cache-total-count').filter({hasText:'0 个缓存'}).waitFor();assert.equal(new URL(admin.url()).protocol,'http:');
 await admin.screenshot({path:`/tmp/voidplayer-http-admin-${name}.png`});
 for(const p of [port,alias]){const base=`http://${address}:${p}`;assert.equal((await page.request.get(base+'/llms.txt')).status(),200);assert.equal((await page.request.get(base+'/api/library')).status(),200);assert.equal((await page.request.get(base+'/admin')).status(),200);}
 // Accepted and rejected certificate states use separate disposable contexts.
 const accepted=await pageFor(true);await accepted.page.goto(remote+original);await accepted.page.waitForURL(secure+original);await accepted.page.waitForFunction(()=>window.voidPlayer);assert.equal(await accepted.page.evaluate(()=>isSecureContext),true);
 const direct=await accepted.context.newPage();await direct.goto(secure+'/connection');await direct.locator('#connection-setup').waitFor();assert.equal(new URL(direct.url()).pathname,'/connection','explicit certificate page remains accessible');await direct.close();
 // A reachable server with a failed probe stays on the guide, rather than redirecting into a browser error.
 await accepted.page.route('**/api/connection/probe',route=>route.fulfill({status:503,json:{error:'unavailable'}}));await accepted.page.goto(`http://${address}:${alias}/?space=default#notes`);await accepted.page.locator('#connection-setup').waitFor();assert.equal(new URL(accepted.page.url()).protocol,'http:');
 await accepted.page.setViewportSize({width:390,height:844});await accepted.page.screenshot({path:`/tmp/voidplayer-http-mobile-${name}.png`});assert.ok(await accepted.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: untrusted HTTP guide, accepted HTTPS handoff with query/hash, retry, direct certificate page, HTTP admin/llms/APIs, unavailable HTTPS and responsive rendering`);
 await accepted.context.close();await context.close();
}finally{await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
