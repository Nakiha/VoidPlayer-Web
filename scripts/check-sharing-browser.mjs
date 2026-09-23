import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'vp-share-browser-'));
let service,browser;
try {
  await mkdir(path.join(root,'media'));
  await writeFile(path.join(root,'media/sample.mp4'),Buffer.from(await readFile(new URL('../test/http-smoke.mp4.base64',import.meta.url),'utf8'),'base64'));
  const config=await loadConfig(['--folder',path.join(root,'media'),'--data-dir',path.join(root,'data')],'production');config.port=0;config.logsDir=null;
  service=await startService(config);await service.library.refresh();config.port=service.server.address().port;
  const base=`http://127.0.0.1:${config.port}`;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}}), page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{Object.defineProperty(navigator.clipboard,'writeText',{value:async value=>{window.testClipboard=value;}});});
  await page.goto(base);await page.locator('#identity-welcome [data-guest]').click();
  await page.evaluate(async()=>{
    const api=window.voidPlayer, tools=api.tools;
    // Freshly written sources stay pending until the settle rescan confirms them.
    let library;
    for(let i=0;i<100;i++){
      library=await tools.find(t=>t.name==='list_library').execute({});
      if(library.entries[0]?.state==='ready')break;
      await new Promise(r=>setTimeout(r,100));
    }
    await tools.find(t=>t.name==='load_library_item').execute({slot:'A',id:library.entries[0].id});
    await api.seek(200000);api.addMark({slot:'A',text:'分享时的标注'});
  });
  await page.locator('#toggle-sources').click();
  await page.locator('#library-root').click();await page.locator('#library-root-menu').getByRole('menuitemradio',{name:'全部媒体',exact:true}).click();
  await page.locator('#sources-search-toggle').click();
  await page.locator('#source-search').fill('sample');
  await page.locator('#settings-open').click(); await page.locator('#settings-tab-workspace').click();
  await page.locator('#saved-workspace-name').fill('分享评审');
  const snapshot=await page.evaluate(()=>window.voidPlayer.exportWorkspace());
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/shares',async route=>{await gate;await route.continue();});
  await page.locator('#saved-workspace-share').click();
  await page.waitForFunction(()=>document.querySelector('#workspace-share').getAttribute('aria-busy')==='true');
  assert.equal(await page.locator('#workspace-share').isDisabled(),true);
  await page.evaluate(()=>window.voidPlayer.addMark({slot:'A',text:'点击之后的修改'}));release();
  await page.waitForFunction(()=>!!window.testClipboard);
  const link=await page.evaluate(()=>window.testClipboard);
  assert.equal(await page.locator('#saved-workspace-share').innerHTML(), await page.locator('#workspace-share').innerHTML());
  await page.locator('.saved-workspace-open strong').filter({hasText:'分享评审'}).waitFor();
  await page.locator('#saved-workspace-name').fill('改名后的评审'); await page.locator('#saved-workspace-name').press('Enter');
  await page.locator('.saved-workspace-open strong').filter({hasText:'改名后的评审'}).waitFor();
  assert.match(await page.locator('.toast-stack').innerText(),/已复制/);
  const response=await page.request.get(base+'/api/shares/'+new URL(link).searchParams.get('share'));
  const stored=(await response.json()).document;
  assert.equal(stored.name, '分享评审');assert.deepEqual(stored.marks,snapshot.marks);assert.equal(stored.positionUs,snapshot.positionUs);
  await service.close();service=await startService(config);await service.library.refresh();
  const recipient=await browser.newContext(), other=await recipient.newPage();other.on('pageerror',e=>errors.push(e.message));
  await other.goto(link);await other.locator('#identity-welcome [data-guest]').click();
  await other.waitForFunction(()=>window.voidPlayer?.getState().tracks.length===1&&!window.voidPlayer.getState().busy);
  await other.locator('.toast-stack .toast').filter({hasText:'已还原分享快照'}).waitFor();
  const restored=await other.evaluate(()=>window.voidPlayer.exportWorkspace());
  assert.equal(await other.locator('#source-search').inputValue(),'sample');
  assert.match(await other.locator('#library-location').inputValue(),/全部媒体/);
  for(const key of ['name','tracks','marks','viewport','layout','positionUs'])assert.deepEqual(restored[key],stored[key],key);
  const added=await other.evaluate(()=>window.voidPlayer.addMark({slot:'A',text:'分享后新增的云端标注'}));
  await other.waitForFunction(id=>window.voidPlayer.getState().marks.some(mark=>mark.id===id),added.id);
  let cloud;
  for(let i=0;i<100;i++){
    cloud=await other.request.get(base+'/api/annotations/spaces/default').then(r=>r.json());
    if(cloud.entries.some(record=>record.id===added.id))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(cloud.entries.some(record=>record.id===added.id),'a mark added after opening a share syncs to the cloud');
  assert.equal((await response.json()).document.marks.some(mark=>mark.id===added.id),false,'the original share stays immutable');
  assert.deepEqual((await other.request.get(base+'/api/users').then(r=>r.json())).users,[]);
  await other.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{value:async value=>{window.failedLink=value;throw new Error('denied');}}));
  await other.locator('#workspace-share').click();
  const fallback = other.locator('.toast-stack .toast').filter({hasText:'请复制下方链接'});
  await fallback.waitFor();
  assert.equal(await fallback.locator('.toast-action').innerText(), '复制链接');
  const updatedLink=await other.evaluate(()=>window.failedLink);
  assert.notEqual(updatedLink,link,'sharing again creates a new link');
  const updatedSnapshot=await other.request.get(base+'/api/shares/'+new URL(updatedLink).searchParams.get('share')).then(r=>r.json());
  assert.ok(updatedSnapshot.document.marks.some(mark=>mark.id===added.id),'the new link contains later marks');
  await other.reload();assert.equal(await other.locator('#identity-welcome').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: guest onboarding, immutable click snapshot, busy UI, restart, second-browser restore and clipboard fallback');
} finally {await browser?.close();await service?.close();await rm(root,{recursive:true,force:true});}
