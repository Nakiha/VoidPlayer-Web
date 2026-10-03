import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {withBrowserFixture} from '../../browser-fixture.mjs';
const engine=process.argv[2]??'chromium';
await withBrowserFixture({caseName:'i18n',engine,pageOptions:{viewport:{width:1280,height:800},locale:'zh-CN',reducedMotion:'reduce'}},async ({page,context,newContext,ready,artifact,url})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.__workers=0;const Original=Worker;window.Worker=class extends Original{constructor(...args){super(...args);window.__workers++;}};});
 await ready();
 const peer=await context.newPage();await peer.goto(url);await peer.waitForFunction(()=>window.voidPlayer);
 async function switchLanguage(locale){await peer.evaluate(locale=>localStorage.setItem('voidplayer.language',locale),locale);await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);}
 // Deterministic UI catalog boundary, not a new agent/session protocol.
 await page.evaluate(async()=>{const tools=window.voidPlayer.tools;const lib=await tools.find(t=>t.name==='list_library').execute({});const item=lib.entries.find(e=>e.name==='h264_9s_1920x1080.mp4');if(!item)throw new Error('Missing required sample');await tools.find(t=>t.name==='load_library_item').execute({slot:'A',id:item.id});});
 await page.locator('#toggle-inspector').click();await page.locator('#toggle-subtracks').click();
 await page.evaluate(()=>window.voidPlayer.addMark({slot:'A',text:'用户内容 User text {braces}'}));
 await page.waitForTimeout(100);
 await page.evaluate(()=>{
   window.__canvas=document.querySelector('#canvas-A');window.__offset=document.querySelector('.track-offset.offset-input');window.__inspector=document.querySelector('#track-selector .track-choice');window.__mark=document.querySelector('.mark-entry');
   window.__session=JSON.stringify(window.voidPlayer.getState().tracks.map(t=>[t.slot,t.id,t.sourceGen,t.offsetUs,t.name]));
   window.__workspace=JSON.stringify(window.voidPlayer.getWorkspace());
   window.__offset.focus();window.__offset.value='未提交 123.456 ms';window.__offset.setSelectionRange(3,6);
 });
 await switchLanguage('en');
 assert.match(await page.locator('#inspector-panel').getAttribute('aria-label'),/Track/);
 assert.match(await page.locator('#track-properties').innerText(),/Codec|Dimensions/);
 assert.match(await page.locator('#track-properties dd[data-tooltip]').first().getAttribute('data-tooltip'),/format|metadata|bitstream|container/i);
 assert.match(await page.locator('.track-offset.offset-input').getAttribute('aria-label'),/offset/);
 assert.deepEqual(await page.evaluate(()=>({canvas:window.__canvas===document.querySelector('#canvas-A'),offset:window.__offset===document.querySelector('.track-offset.offset-input'),inspector:window.__inspector===document.querySelector('#track-selector .track-choice'),mark:window.__mark===document.querySelector('.mark-entry'),focus:document.activeElement===window.__offset,value:window.__offset.value,selection:[window.__offset.selectionStart,window.__offset.selectionEnd],session:window.__session===JSON.stringify(window.voidPlayer.getState().tracks.map(t=>[t.slot,t.id,t.sourceGen,t.offsetUs,t.name]))})),{canvas:true,offset:true,inspector:true,mark:true,focus:true,value:'未提交 123.456 ms',selection:[3,6],session:true});
 // A refresh cache hit must not rebuild inspector, dock, marks or input nodes.
 await page.evaluate(()=>window.voidPlayer.getState());
 const tooltip=page.locator('#track-properties dd[data-tooltip]').first();
 await tooltip.hover();await page.getByRole('tooltip').waitFor({state:'visible'});assert.match(await page.getByRole('tooltip').innerText(),/format|metadata|bitstream|container/i);
 await switchLanguage('zh-CN');assert.match(await page.getByRole('tooltip').innerText(),/格式|来源/);await switchLanguage('en');
 await page.locator('#settings-open').click();await page.locator('#settings-tab-workspace').click();
 await page.locator('#saved-workspace-name').fill('未保存 Workspace name');await page.locator('#saved-workspace-name').evaluate(e=>{e.focus();e.setSelectionRange(2,6);window.__edit=e;});
 await switchLanguage('zh-CN');
 assert.equal(await page.locator('#settings-current-title').innerText(),'工作区');
 assert.deepEqual(await page.evaluate(()=>({same:window.__edit===document.querySelector('#saved-workspace-name'),focus:document.activeElement===window.__edit,value:window.__edit.value,selection:[window.__edit.selectionStart,window.__edit.selectionEnd],open:document.querySelector('#settings').open})),{same:true,focus:true,value:'未保存 Workspace name',selection:[2,6],open:true});
 await page.locator('#settings-tab-logs').click();await page.locator('#log-description').fill('未提交 Report <原文>');await page.locator('#log-description').evaluate(e=>{e.focus();e.setSelectionRange(1,4);window.__report=e;});await switchLanguage('en');
 assert.equal(await page.locator('#log-description').inputValue(),'未提交 Report <原文>');assert.equal(await page.evaluate(()=>document.activeElement===window.__report),true);assert.match(await page.locator('#log-description').getAttribute('placeholder'),/happened|reproduce/i);
 await page.locator('#settings-tab-performance').click();const originalFlow=await page.locator('#color-flow-diagram').evaluate(e=>{window.__flow=e.firstElementChild;return e.innerText;});await switchLanguage('zh-CN');assert.equal(await page.evaluate(()=>window.__flow===document.querySelector('#color-flow-diagram').firstElementChild),true);assert.notEqual(await page.locator('#color-flow-diagram').innerText(),originalFlow);
 // Open choice menus retain their nodes and focus when a peer changes locale.
 await page.locator('#settings-tab-appearance').click();await page.locator('#language-choice').click();await page.locator('#language-choice-menu [data-value=system]').focus();await switchLanguage('en');assert.equal(await page.locator('#language-choice-menu').evaluate(e=>e.matches(':popover-open')),true);assert.equal(await page.evaluate(()=>document.activeElement?.dataset.value),'system');
 await page.locator('#language-choice').click();
 await page.screenshot({path:artifact('settings-en.png')});
 for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']){await page.locator(`#settings-tab-${pane}`).click();const chinese=await page.locator(`#settings-pane-${pane}`).evaluate(el=>{const skip='input,textarea,code';const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const found=[];while(w.nextNode()){const n=w.currentNode;if(n.parentElement.closest(skip)||!n.parentElement.getClientRects().length)continue;if(/[\u4e00-\u9fff]/.test(n.textContent)&&!n.parentElement.closest('#identity-current,.saved-workspace-row,#color-runtime-tracks'))found.push(n.textContent.trim());}return found;});assert.deepEqual(chinese,[],`English settings completeness: ${pane}`);}
 await page.locator('#settings-close').click();
 // Commit no editable values: close settings restores focus without changing user data.
 await page.evaluate(()=>{window.__offset.blur();window.__offset.value='0 ms';});
 await page.evaluate(()=>window.voidPlayer.seek(0));await page.evaluate(()=>window.voidPlayer.play());await page.waitForTimeout(250);
 const before=await page.evaluate(async()=>({state:window.voidPlayer.getState(),workers:window.__workers,logs:(await window.voidPlayer.getLogs({limit:1000})).lastSeq}));
 const start=performance.now();await switchLanguage('zh-CN');await switchLanguage('en');const switchMs=performance.now()-start;
 const after=await page.evaluate(async sinceSeq=>({state:window.voidPlayer.getState(),workers:window.__workers,logs:(await window.voidPlayer.getLogs({sinceSeq,limit:1000})).events}),before.logs);
 assert.equal(before.state.playing,true);assert.equal(after.state.playing,true);assert.ok(after.state.positionUs>=before.state.positionUs);assert.equal(after.workers,before.workers);
 assert.deepEqual(after.state.tracks.map(t=>[t.id,t.sourceGen,t.offsetUs]),before.state.tracks.map(t=>[t.id,t.sourceGen,t.offsetUs]));
 assert.deepEqual(after.logs.filter(e=>e.data?.action&&/seek|pause|load|color-mode/.test(e.data.action)),[],'switch performs no session seek/pause/reload');assert.equal(await page.evaluate(()=>window.__canvas===document.querySelector('#canvas-A')),true);
 await page.screenshot({path:artifact('playing-en.png')});
 await page.evaluate(()=>window.voidPlayer.pause());
 await peer.evaluate(()=>{localStorage.setItem('voidplayer.language','zh-CN');localStorage.setItem('voidplayer.language','en');localStorage.setItem('voidplayer.language','zh-CN');});await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');
 await page.screenshot({path:artifact('playing-zh.png')});await page.reload();await page.waitForFunction(()=>window.voidPlayer);assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
 // Failed cold language chunk: keep the complete old locale; retry succeeds.
 const failure=await context.newPage();await failure.route('**/assets/en-*.js',route=>route.abort());await failure.goto(url);await failure.waitForFunction(()=>window.voidPlayer);await failure.locator('#settings-open').click();await failure.locator('#language-choice').click();await failure.locator('#language-choice-menu [data-value=en]').click();await failure.waitForFunction(()=>document.querySelector('#language-status').textContent.length>0);assert.equal(await failure.locator('html').getAttribute('lang'),'zh-CN');assert.match(await failure.locator('#language-status').innerText(),/重试/);await failure.unroute('**/assets/en-*.js');await failure.locator('#language-choice').click();await failure.locator('#language-choice-menu [data-value=en]').click();await failure.waitForFunction(()=>document.documentElement.lang==='en');await failure.close();
 // A cold delayed English response may complete after the newer Chinese choice.
 const delayedContext=await newContext({locale:'zh-CN'}),delayed=await delayedContext.newPage();
 let release,started;const requested=new Promise(resolve=>started=resolve);
 await delayed.route('**/assets/en-*.js',route=>{release=()=>route.continue();started();});
 await delayed.goto(url);await delayed.waitForFunction(()=>window.voidPlayer);
 await delayed.locator('#settings-open').click();await delayed.locator('#language-choice').click();await delayed.locator('#language-choice-menu [data-value=en]').click();await requested;
 await delayed.locator('#language-choice').click();await delayed.locator('#language-choice-menu [data-value="zh-CN"]').click();await release();await delayed.waitForTimeout(150);
 assert.equal(await delayed.locator('html').getAttribute('lang'),'zh-CN');assert.equal(await delayed.evaluate(()=>localStorage.getItem('voidplayer.language')),'zh-CN');await delayedContext.close();
 for(const [browserLocale,stored,expected] of [['zh-TW',null,'zh-CN'],['en-US',null,'en'],['ja-JP',null,'en'],['en-US','zh-CN','zh-CN'],['zh-CN','invalid','zh-CN']]){
  const systemContext=await newContext({locale:browserLocale});if(stored)await systemContext.addInitScript(value=>localStorage.setItem('voidplayer.language',value),stored);
  const systemPage=await systemContext.newPage();await systemPage.goto(url);await systemPage.waitForFunction(()=>window.voidPlayer);assert.equal(await systemPage.locator('html').getAttribute('lang'),expected);await systemContext.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile(artifact('report.json'),JSON.stringify({engine,switchMs,assertions:['playing-switch','no-session-operations','stable-workers/source/canvas','cached-inspector','offset-selection','workspace-draft','report-draft','open-settings','open-menu-focus','flow-nodes','user-marks','rapid-switch','reload-preference','cold-chunk-failure/retry','complete-settings','cold-stale-response','system-locale-normalization','stored-preference-precedence'],errors},null,2));
 console.log(`PASS ${engine}: i18n state preservation, complete settings, rapid switching, load failure and persistence`);
 await peer.close();
});
