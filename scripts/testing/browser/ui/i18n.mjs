import assert from 'node:assert/strict';
import {writeFile,mkdir,copyFile,readFile,utimes} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../../../../server/config.ts';
import {startService} from '../../../../server/runtime.ts';
import {repositoryRoot} from '../../manifest.mjs';
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
 const tooltipPopup=page.getByRole('tooltip');
 const tooltipEvidence=[];
 const settleLayout=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 async function checkHoveredTooltip(locale,pattern){
  await switchLanguage(locale);await settleLayout();
  // Translated labels above the value can wrap, moving the value away from a
  // stationary pointer. Hover the actual localized geometry before reading it.
  await tooltip.hover();await tooltipPopup.waitFor({state:'visible'});
  assert.match(await tooltipPopup.innerText(),pattern);
  tooltipEvidence.push(await tooltip.evaluate(e=>({kind:'hover',lang:document.documentElement.lang,hovered:e.matches(':hover'),rect:e.getBoundingClientRect().toJSON(),text:document.querySelector('#control-tooltip').textContent})));
  assert.equal(tooltipEvidence.at(-1).hovered,true);
 }
 await checkHoveredTooltip('en',/format|metadata|bitstream|container/i);
 await checkHoveredTooltip('zh-CN',/格式|来源/);
 // Capture the event sequence in CI as well as successful local runs.
 await page.evaluate(()=>{
  window.__tooltipEvents=[];
  window.__recordTooltip=label=>{const a=document.querySelector('#track-properties dd[data-tooltip]'),p=document.querySelector('#control-tooltip');window.__tooltipEvents.push({at:performance.now(),label,lang:document.documentElement.lang,focused:document.activeElement===a,documentFocus:document.hasFocus(),anchor:a.getBoundingClientRect().toJSON(),popup:{hidden:p.hidden,text:p.textContent}});};
  window.__tooltipEventsAbort=new AbortController();
  for(const type of ['focusin','focusout','pointerout','scroll','blur'])window.addEventListener(type,e=>window.__recordTooltip({type,target:e.target?.id||e.target?.nodeName,related:e.relatedTarget?.id||e.relatedTarget?.nodeName,scrollTop:e.target?.scrollTop}),{capture:true,signal:window.__tooltipEventsAbort.signal});
  const hide=HTMLElement.prototype.hidePopover;window.__tooltipOriginalHide=hide;
  HTMLElement.prototype.hidePopover=function(...args){if(this.id==='control-tooltip')window.__recordTooltip({hidePopover:true,stack:new Error().stack});return hide.apply(this,args);};
  const timeout=window.setTimeout;window.__tooltipOriginalTimeout=timeout;
  window.setTimeout=(cb,delay,...args)=>{if(typeof cb!=='function')return timeout(cb,delay,...args);const traced=[0,120,350].includes(delay);if(traced)window.__recordTooltip({timer:'schedule',delay,callback:cb.toString().slice(0,160)});return timeout(()=>{if(traced)window.__recordTooltip({timer:'fire',delay,callback:cb.toString().slice(0,160)});cb.apply(window,args);},delay);};
  window.__tooltipOriginalMaxHeight=document.querySelector('#track-properties').style.maxHeight;
 });
 // Keyboard focus remains on the original value despite translated layout.
 // This specifically verifies MutationObserver refresh without another hover
 // or focus event, so stale translations cannot pass by reopening the popup.
 await page.mouse.move(700,400);await page.keyboard.press('Tab');await tooltip.focus();
 await tooltipPopup.waitFor({state:'visible'});
 await tooltip.evaluate(e=>{window.__tooltipAnchor=e;window.__tooltipPopup=document.querySelector('#control-tooltip');});
 for(const scenario of ['original','queued-scroll']){
 if(scenario==='queued-scroll')await page.evaluate(()=>{document.querySelector('#track-properties').style.maxHeight='410px';});
 for(const [locale,pattern] of [['en',/format|metadata|bitstream|container/i],['zh-CN',/格式|来源/],['en',/format|metadata|bitstream|container/i]]){
  await page.evaluate(({locale,scenario})=>{window.__recordTooltip({phase:'before-focused-switch',scenario});if(scenario==='queued-scroll'){const port=document.querySelector('#track-properties');if(port.scrollHeight<=port.clientHeight)throw new Error('Required inspector scroll fixture');port.scrollTop=locale==='en'?1:0;}},{locale,scenario});
  await switchLanguage(locale);await settleLayout();
  await page.evaluate(()=>window.__recordTooltip('after-focused-switch'));
  await writeFile(artifact('tooltip-events.json'),JSON.stringify(await page.evaluate(()=>window.__tooltipEvents),null,2));
  assert.equal(await tooltipPopup.isVisible(),true,'focused tooltip stays visible through locale commit and layout');
  assert.match(await tooltipPopup.innerText(),pattern);
  assert.deepEqual(await page.evaluate(()=>({anchor:window.__tooltipAnchor===document.querySelector('#track-properties dd[data-tooltip]'),popup:window.__tooltipPopup===document.querySelector('#control-tooltip'),focus:document.activeElement===window.__tooltipAnchor,described:window.__tooltipAnchor.getAttribute('aria-describedby')})),{anchor:true,popup:true,focus:true,described:'control-tooltip'});
  tooltipEvidence.push(await tooltip.evaluate((e,scenario)=>({kind:'focus',scenario,lang:document.documentElement.lang,rect:e.getBoundingClientRect().toJSON(),text:document.querySelector('#control-tooltip').textContent}),scenario));
  if(locale==='zh-CN'&&scenario==='original')await page.screenshot({path:artifact('focused-tooltip-zh.png')});
 }
 }
 // Focus help survives unrelated/stale events, but leaves the viewport safely.
 await page.evaluate(()=>{document.querySelector('.track-offset').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:window.__tooltipAnchor}));document.querySelector('#subtrack-list').dispatchEvent(new Event('scroll'));});
 assert.equal(await tooltipPopup.isVisible(),true);
 await page.evaluate(()=>{const port=document.querySelector('#track-properties');port.style.maxHeight='100px';port.scrollTop=port.scrollHeight;});await settleLayout();
 assert.equal(await tooltip.evaluate(e=>e.getBoundingClientRect().bottom<=e.closest('#track-properties').getBoundingClientRect().top),true,'negative fixture moves focused value outside its scrollport');
 assert.equal(await tooltipPopup.isVisible(),false,'offscreen focused help is hidden');
 assert.equal(await tooltip.evaluate(e=>document.activeElement===e),true,'scroll does not move keyboard focus');
 await page.evaluate(()=>{window.__tooltipEventsAbort.abort();HTMLElement.prototype.hidePopover=window.__tooltipOriginalHide;window.setTimeout=window.__tooltipOriginalTimeout;const port=document.querySelector('#track-properties');port.style.maxHeight=window.__tooltipOriginalMaxHeight;port.scrollTop=0;});
 await writeFile(artifact('tooltip-report.json'),JSON.stringify(tooltipEvidence,null,2));
 await page.evaluate(()=>window.voidPlayer.addMark({slot:'A',text:'',drawings:[{id:'empty-preview',tool:'rect',color:'#ff3b30',strokeWidth:4,points:[{x:.2,y:.2},{x:.4,y:.4}]}]}));
 await page.locator('#toggle-marks').click();
 const emptyThumbnail=page.locator('.mark-thumbnail').filter({hasText:'No preview'});
 await emptyThumbnail.waitFor();await emptyThumbnail.evaluate(e=>{window.__emptyThumbnail=e;});
 await switchLanguage('zh-CN');assert.equal(await page.evaluate(()=>window.__emptyThumbnail.textContent),'暂无预览');
 await switchLanguage('en');assert.equal(await page.evaluate(()=>window.__emptyThumbnail.textContent),'No preview');
 assert.equal(await page.evaluate(()=>window.__emptyThumbnail.isConnected),true);
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
 for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']){await page.locator(`#settings-tab-${pane}`).click();const chinese=await page.locator(`#settings-pane-${pane}`).evaluate(el=>{const skip='input,textarea,code';const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const found=[];while(w.nextNode()){const n=w.currentNode;if(n.parentElement.closest(skip)||!n.parentElement.getClientRects().length)continue;if(/[\u4e00-\u9fff]/.test(n.textContent)&&!n.parentElement.closest('#identity-current,.saved-workspace-row,.checkpoint-history-row .saved-workspace-info strong,#color-runtime-tracks'))found.push(n.textContent.trim());}return found;});assert.deepEqual(chinese,[],`English settings completeness: ${pane}`);}
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

// Real identity service and an owned directory exercise modal/cached-row lifetimes.
await withBrowserFixture({caseName:'i18n-dialogs',engine,pageOptions:{viewport:{width:1280,height:800},locale:'zh-CN',reducedMotion:'reduce'},dependencies:{startService:async({temp,defer})=>{
 const media=path.join(temp,'media');await mkdir(path.join(media,'用户目录'),{recursive:true});
 await copyFile(path.join(repositoryRoot,'fixtures/video/ci_h264_smoke.mp4'),path.join(media,'sample.mp4'));await utimes(path.join(media,'sample.mp4'),1000,1000);
 const config=await loadConfig(['--folder',media,'--data-dir',temp],'production');config.port=0;config.logsDir=null;config.indexWatch=false;
 const service=await startService(config);let closed=false;const close=async()=>{if(closed)return;closed=true;await service.close();};defer('partial-service',close);await service.library.refresh();
 return {...service,close,url:`http://127.0.0.1:${service.server.address().port}/`};
}}},async({page,context,newContext,url,artifact})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=await newContext({locale:'zh-CN'});
 for(const name of ['用户甲','用户乙']){const response=await seed.request.post(`${url}api/identity`,{headers:{origin:url.slice(0,-1),'x-voidplayer-action':'identity'},data:{name,mode:'create'}});assert.equal(response.status(),200);}
 await seed.close();
 // The peer changes only locale storage; it need not enter onboarding.
 const peer=await context.newPage();await peer.goto(url);
 await page.goto(url);const welcome=page.locator('#identity-welcome');await welcome.waitFor({state:'visible'});
 const input=welcome.locator('input');await page.waitForFunction(()=>!document.querySelector('.welcome-toggle').hidden);
 await input.fill('不匹配的用户草稿');await welcome.locator('.welcome-toggle').click();await input.press('ArrowDown');
 const snapshot=await input.evaluate(e=>{e.setSelectionRange(1,4);window.__welcomeInput=e;window.__welcomeOption=document.getElementById(e.getAttribute('aria-activedescendant'));return {active:e.getAttribute('aria-activedescendant'),options:[...document.querySelectorAll('#welcome-users [role=option]')].map(e=>e.textContent)};});
 async function switchLanguage(locale){await peer.evaluate(locale=>localStorage.setItem('voidplayer.language',locale),locale);await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);}
 await switchLanguage('en');
 assert.equal(await welcome.locator('#identity-welcome-title').innerText(),'What should we call you?');
 assert.equal(await input.getAttribute('placeholder'),'Name (optional)');assert.equal(await input.getAttribute('aria-label'),'Name (optional)');
 assert.equal(await welcome.locator('.welcome-toggle').getAttribute('aria-label'),'Choose an existing user');
 assert.equal(await welcome.locator('#welcome-users').getAttribute('aria-label'),'Existing user');
 assert.deepEqual(await input.evaluate(e=>({same:e===window.__welcomeInput,focus:e===document.activeElement,value:e.value,selection:[e.selectionStart,e.selectionEnd],active:e.getAttribute('aria-activedescendant'),option:window.__welcomeOption===document.getElementById(e.getAttribute('aria-activedescendant')),options:[...document.querySelectorAll('#welcome-users [role=option]')].map(e=>e.textContent),expanded:e.getAttribute('aria-expanded')})),{same:true,focus:true,value:'不匹配的用户草稿',selection:[1,4],active:snapshot.active,option:true,options:snapshot.options,expanded:'true'});
 assert.equal(snapshot.options.length,2,'show-all mode retains both users despite unmatched input');
 await page.screenshot({path:artifact('welcome-en.png')});await switchLanguage('zh-CN');
 assert.equal(await welcome.locator('#identity-welcome-title').innerText(),'怎么称呼你？');
 await input.press('Escape');await input.fill('');await welcome.locator('button[type=submit]').click();await page.waitForFunction(()=>window.voidPlayer?.tools);await welcome.waitFor({state:'detached'});
 await page.locator('#toggle-sources').click();await page.locator('#library-root').click();await page.locator('#library-root-menu [data-value]').filter({hasText:'media'}).click();
 const folder=page.locator('#source-list .library-folder').filter({hasText:'用户目录'});await folder.waitFor();await folder.evaluate(e=>{e.focus();window.__folder=e;});
 await switchLanguage('en');assert.match(await folder.locator('.source-meta').innerText(),/^Library · /);assert.equal(await folder.getAttribute('aria-label'),'Open folder: 用户目录');
 assert.equal(await folder.evaluate(e=>e===window.__folder&&document.activeElement===e),true);
 await switchLanguage('zh-CN');assert.match(await folder.locator('.source-meta').innerText(),/^媒体库 · /);assert.equal(await folder.evaluate(e=>e===window.__folder&&document.activeElement===e),true);
 await page.waitForFunction(async()=>{const library=await window.voidPlayer.tools.find(t=>t.name==='list_library').execute({});return library.entries.find(e=>e.name==='sample.mp4')?.state==='ready';});
 const library=await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='list_library').execute({}));
 const sample=library.entries.find(e=>e.name==='sample.mp4');const stalled=[];
 await page.route(`**/api/media/${sample.id}?*`,route=>stalled.push(route));
 const sampleRow=page.locator('#source-list .source-row').filter({hasText:'sample.mp4'});
 const requested=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/media/${sample.id}`);
 await sampleRow.getByRole('button',{name:'添加到视图：sample.mp4',exact:true}).click();await requested;
 const cancel=sampleRow.getByRole('button',{name:'取消载入：sample.mp4',exact:true});await cancel.waitFor();
 await cancel.evaluate(e=>{e.focus();window.__cancel=e;});await switchLanguage('en');
 assert.equal(await sampleRow.locator('[data-action=cancel-load]').getAttribute('aria-label'),'Cancel load: sample.mp4');
 assert.equal(await sampleRow.locator('[data-action=cancel-load]').evaluate(e=>e===window.__cancel&&e===document.activeElement),true);
 assert.match(await page.locator('#source-activity-stage').innerText(),/Reading video information/i);
 await switchLanguage('zh-CN');assert.equal(await cancel.evaluate(e=>e===window.__cancel),true);await cancel.click();
 for(const route of stalled)await route.abort();await page.unroute(`**/api/media/${sample.id}?*`);
 await page.evaluate(async id=>{await window.voidPlayer.tools.find(t=>t.name==='load_library_item').execute({slot:'A',id});},library.entries.find(e=>e.name==='sample.mp4').id);
 const workspace=await page.evaluate(()=>window.voidPlayer.exportWorkspace());delete workspace.media[0].source;
 // Keep import pending so the open dialog remains reviewable during peer switches.
 await page.evaluate(document=>{window.__import=window.voidPlayer.importWorkspace(document);},workspace);
 const relink=page.locator('.workspace-relink');await relink.waitFor({state:'visible'});
 const bytes=await readFile(path.join(repositoryRoot,'fixtures/video/ci_h264_smoke.mp4'));
 await relink.locator('input[type=file]').setInputFiles({name:'sample.mp4',mimeType:'video/mp4',buffer:bytes});
 await relink.locator('.relink-continue').waitFor({state:'visible'});assert.equal(await relink.locator('.relink-continue').isEnabled(),true);
 await relink.locator('input').evaluate(e=>{e.focus();window.__relinkInput=e;window.__selectedFile=e.files[0];window.__relinkDialog=e.closest('dialog');});
 await switchLanguage('en');assert.match(await relink.locator('[role=alert]').innerText(),/modification time/);assert.equal(await relink.getAttribute('aria-label'),'Reconnect local videos');assert.equal(await relink.locator('h2').innerText(),'Reconnect local videos');
 assert.equal(await relink.locator('header button').getAttribute('aria-label'),'Cancel import');assert.equal(await relink.locator('.relink-later').innerText(),'Later');
 assert.equal(await relink.locator('.relink-continue').innerText(),'Open workspace');assert.match(await relink.locator('input').getAttribute('aria-label'),/^Pick sample.mp4 again$/);
 assert.deepEqual(await relink.locator('input').evaluate(e=>({same:e===window.__relinkInput,dialog:e.closest('dialog')===window.__relinkDialog,file:e.files[0]===window.__selectedFile,focus:e===document.activeElement,name:e.files[0].name,enabled:!document.querySelector('.relink-continue').disabled})),{same:true,dialog:true,file:true,focus:true,name:'sample.mp4',enabled:true});
 await page.screenshot({path:artifact('relink-en.png')});await switchLanguage('zh-CN');assert.equal(await relink.locator('h2').innerText(),'重新连接本地视频');
 await relink.locator('header button').click();assert.equal(await page.evaluate(()=>window.__import),false);
 await peer.close();assert.deepEqual(errors,[]);
 await writeFile(artifact('dialog-report.json'),JSON.stringify({engine,assertions:['onboarding-text/aria','onboarding-filter/active-option/node/focus/selection','folder-meta/node/focus','stalled-load-stage/cancel-node/focus','relink-text/aria','relink-file/dialog/node/focus','relink-cancel-preserves-session'],errors},null,2));
 console.log(`PASS ${engine}: onboarding, folder cache and relink modal switch in place`);
});
