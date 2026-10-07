import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name=process.argv[2]??'webkit';
await withBrowserFixture({ caseName: 'theme', engine: name, pageOptions: {viewport:{width:1280,height:900},deviceScaleFactor:2,colorScheme:'light'} }, async ({ page, context, newContext, url, ready, artifact }) => {
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const base=url;
 await ready();
 // bootstrap.ts 以动态 import 加载 main.ts，window.voidPlayer 不再同步可得。
 await page.waitForFunction(()=>window.voidPlayer?.tools,null,{timeout:30000});
 const theme=()=>page.locator('html').getAttribute('data-theme');
 const choose=async value=>{await page.locator('#settings-open').click();await page.locator(`[data-theme-choice=${value}]`).click();await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));};
 const call=(name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 assert.equal(await theme(),'light');
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 assert.equal(await page.locator('[data-theme-choice=system]').getAttribute('aria-checked'),'true');
 await choose('light');assert.equal(await theme(),'light');
 await page.emulateMedia({colorScheme:'light'});await page.emulateMedia({colorScheme:'dark'});assert.equal(await theme(),'light');
 // Inline bootstrap must resolve the stored choice even before the app module runs.
 const boot=await context.newPage();await boot.emulateMedia({colorScheme:'dark'});
 await boot.route('**/assets/*.js',route=>route.abort());await boot.goto(base);
 assert.equal(await boot.locator('html').getAttribute('data-theme'),'light');await boot.close();
 await page.reload();assert.equal(await theme(),'light');
 // Reload resolves before bootstrap's dynamic main import necessarily publishes the tools.
 // Keep the first-paint assertion above, then wait for the API before using it again.
 await page.waitForFunction(()=>window.voidPlayer?.tools,null,{timeout:30000});
 const lib=await call('list_library');
 for(const [slot,file] of [['A','av1_10s_1920x1080.webm'],['B','h264_9s_1920x1080.mp4']])await call('load_library_item',{slot,id:lib.entries.find(e=>e.name===file).id});
 // 索引在后台构建：等它完成、会话空闲后再取基线。否则下面的 before/after 深比较
 // 会把 indexState 从 building 推进到 complete、metadataRevision 自增误判成主题改动的差异。
 await page.waitForFunction(()=>{const s=window.voidPlayer.getState();return !s.busy&&s.tracks.length===2&&s.tracks.every(t=>t.frame&&t.indexState==='complete');},null,{timeout:60000});
 for(const id of ['toggle-inspector','toggle-sources','toggle-subtracks'])await page.locator(`#${id}`).click();
 await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });await page.keyboard.press('n');await page.locator('[data-drawing-tool=rect]').click();
 const stage=await page.locator('#drawing-A').boundingBox();await page.mouse.move(stage.x+stage.width*.2,stage.y+stage.height*.2);await page.mouse.down();await page.mouse.move(stage.x+stage.width*.5,stage.y+stage.height*.55,{steps:5});await page.mouse.up();
 await page.waitForTimeout(220);await page.locator('#mark-close').click();await page.locator('#toggle-marks').click();
 const evidence=()=>page.evaluate(()=>({state:window.voidPlayer.getState(),pixels:window.voidPlayer.captureFrame('A').toDataURL(),shape:document.querySelector('.mark-symbol').dataset.markShape,stage:document.querySelector('#stage-A').getBoundingClientRect().toJSON()}));
 const before=await evidence();
 const lightMark=await page.locator('.track-marker .mark-symbol').first().evaluate(e=>getComputedStyle(e).color);
 await choose('dark');assert.equal(await theme(),'dark');
 await page.evaluate(async () => {
  const transitions = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
  await Promise.all(transitions.map(animation => animation.finished.catch(() => {})));
 });
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 // Only the continuous backing blurs the list; navigation has a thin tint.
 const surfaces=await page.evaluate(()=>{
  const bg=selector=>getComputedStyle(document.querySelector(selector)).backgroundColor;
  const probe=document.createElement('div');probe.style.background='var(--source-control-fill)';document.querySelector('#source-tools').append(probe);
  const control=getComputedStyle(probe).backgroundColor;probe.remove();
  const navStyle=getComputedStyle(document.querySelector('.library-navigation'));
  const backplateStyle=getComputedStyle(document.querySelector('#source-tools'));
  return {segment:bg('#layout-mode [aria-pressed=true]'),search:bg('.library-navigation'),control,filter:navStyle.backdropFilter || navStyle.webkitBackdropFilter,backplateFilter:backplateStyle.backdropFilter || backplateStyle.webkitBackdropFilter,placeholder:getComputedStyle(document.querySelector('#source-search'),'::placeholder').color,grid:document.querySelector('#grid-A').getContext('2d').strokeStyle};
 });
  assert.match(surfaces.segment,/rgba\(255, 255, 255,/,'selected segment uses a light overlay (--segment-selected-fill)');
 assert.equal(surfaces.search,surfaces.control,'library navigation uses a thin control fill');
 assert.equal(surfaces.filter,'none');assert.equal(surfaces.backplateFilter,'blur(6px)');
  assert.equal(surfaces.placeholder,'rgb(182, 182, 182)');
 assert.ok(Number(surfaces.grid.match(/, ([\d.]+)\)$/)[1])<=.15,'grid stays subdued');

 const after=await evidence();assert.deepEqual(after,before,'theme changes preserve session, pixels, mark shape and geometry');
 assert.notEqual(await page.locator('.track-marker .mark-symbol').first().evaluate(e=>getComputedStyle(e).color),lightMark);
 const contrast=await page.evaluate(()=>{
  const root=getComputedStyle(document.documentElement),rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
  const probe=document.createElement('span');document.body.append(probe);
  const color=token=>{probe.style.color=`var(${token})`;return rgb(getComputedStyle(probe).color);};
  const luminance=v=>v.map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((s,c,i)=>s+c*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const results=['--surface','--surface-panel','--preview-fill'].flatMap(bg=>['--text','--text-secondary'].map(fg=>({bg,fg,ratio:ratio(color(bg),color(fg))})));
  probe.remove();return results;
 });assert.ok(contrast.every(c=>c.ratio>=4.5),JSON.stringify(contrast));
 const screenshots=async mode=>{
  await choose(mode);await page.mouse.move(1260,890);await page.waitForTimeout(250);
  await page.screenshot({path:artifact(`voidplayer-theme-${mode}-${name}.png`)});
 };
 await screenshots('light');await screenshots('dark');
 await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });await page.keyboard.press('n');await page.locator('#drawing-color-choice').click();
 await page.screenshot({path:artifact(`voidplayer-theme-palette-${name}.png`)});
 assert.equal(await page.locator('#drawing-color-choice-menu').evaluate(e=>getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter),'blur(8px)');
 await page.keyboard.press('Escape');await page.locator('#mark-close').click();
 await page.emulateMedia({contrast:'more'});
 await page.waitForTimeout(280);
 const high=await page.locator('#position').evaluate(e=>({text:getComputedStyle(e).color,bg:getComputedStyle(document.querySelector('.transport')).backgroundColor,filter:getComputedStyle(document.querySelector('.transport')).backdropFilter || getComputedStyle(document.querySelector('.transport')).webkitBackdropFilter}));
 // prefers-contrast: more pins --viewport-chrome-fill to --surface and drops the blur
 // (themes/accessibility.css), so the transport paints the opaque dark surface:
 // themes/dark.css --surface #212121.
 assert.equal(high.filter,'none');assert.equal(high.bg,'rgb(33, 33, 33)');
 await page.waitForFunction(() => getComputedStyle(document.querySelector('#layout-mode [aria-pressed=true]')).backgroundColor === 'rgb(59, 63, 70)');
 assert.equal(await page.locator('#layout-mode [aria-pressed=true]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(59, 63, 70)');
 assert.equal(await page.locator('.library-navigation').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(33, 33, 33)');
 await page.emulateMedia({contrast:'no-preference'});
 // Compact presets and custom colors stay independent of the review.
 const reviewBefore=await evidence();
 await page.locator('#settings-open').click();
 assert.equal(await page.locator('.accent-palette .accent-choices [role=radio]').count(),12);
 await page.locator('[data-accent-choice=sky]').click();assert.equal(await page.locator('html').getAttribute('data-accent'),'sky');
 const hex=page.locator('#accent-hex');await hex.fill('#E048B8');await hex.press('Enter');
 assert.equal(await page.locator('html').getAttribute('data-accent'),'custom');
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('voidplayer.custom-accent')));
 assert.equal(stored.color,'#e048b8');assert.notEqual(stored.light,stored.dark);
 await hex.fill('#oops');await hex.press('Enter');assert.equal(await hex.getAttribute('aria-invalid'),'true');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('voidplayer.custom-accent'))),stored,'invalid input never changes the active color');
 await hex.press('Escape');assert.equal(await hex.inputValue(),'#E048B8');assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.locator('[data-accent-choice=green]').click();await page.locator('[data-accent-choice=custom]').click();
 assert.equal(await hex.inputValue(),'#E048B8','custom color survives switching to a preset');
 await page.locator('#accent-picker').evaluate(e=>{e.value='#2148ab';e.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.equal(await hex.inputValue(),'#2148AB');
 assert.deepEqual(await evidence(),reviewBefore,'accent edits preserve video, marks and layout');
 for (const mode of ['light','dark']) {
  await page.locator(`[data-theme-choice=${mode}]`).click();await page.locator('#settings').screenshot({path:artifact(`voidplayer-accent-${mode}-${name}.png`)});
 }
 const customBoot=await context.newPage();await customBoot.route('**/assets/*.js',route=>route.abort());await customBoot.goto(base);
 assert.equal(await customBoot.locator('html').getAttribute('data-accent'),'custom');
 assert.equal(await customBoot.locator('html').evaluate(e=>getComputedStyle(e).getPropertyValue('--accent').trim()),await page.locator('html').evaluate(e=>getComputedStyle(e).getPropertyValue('--accent').trim()),'custom first paint matches the loaded app');
 await customBoot.close();
 await page.setViewportSize({width:390,height:700});await page.locator('#settings').screenshot({path:artifact(`voidplayer-accent-mobile-${name}.png`)});
 assert.equal(await page.locator('#settings-pane-appearance').evaluate(e=>e.scrollWidth>e.clientWidth),false);
 await page.setViewportSize({width:1280,height:900});
 await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
 const peer=await context.newPage();await peer.goto(base);assert.equal(await peer.locator('html').getAttribute('data-theme'),'dark');
 await choose('system');await page.waitForFunction(()=>localStorage.getItem('voidplayer.theme')===null);
 await peer.waitForFunction(()=>document.querySelector('[data-theme-choice=system]').getAttribute('aria-checked')==='true');
 await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await page.locator('#settings-open').click();await hex.fill('#ABC');await hex.press('Enter');
 await peer.waitForFunction(()=>document.querySelector('#accent-hex').value==='#AABBCC');
 await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open);
 // Custom bases derive reading surfaces without changing review data or drawing ink.
 for(const close of await page.locator('.toast-close').all()) await close.click();
 await page.locator('#settings-open').click();
 assert.equal(await page.locator('.theme-options [role=radio]').count(),4);
 await page.locator('[data-theme-choice=custom]').click();
 const baseHex=page.locator('#theme-base-hex');
 const customBefore=await evidence(), accentPreference=await page.locator('html').getAttribute('data-accent');
 const presets=page.locator('[data-base-choice]');
 assert.equal(await presets.count(),12);
 for(const button of await presets.all()) {
  const color=await button.getAttribute('data-base-choice');await button.click();
  assert.equal(await baseHex.inputValue(),color.toUpperCase());
  assert.equal(await page.locator('[data-base-choice][aria-checked=true]').count(),1);
  assert.equal(await button.getAttribute('aria-checked'),'true');
  const swatch=await button.locator('.accent-swatch').evaluate(e=>getComputedStyle(e).backgroundColor);
  assert.equal(swatch,`rgb(${[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)).join(', ')})`,'preset circles retain their actual color in light and dark palettes');
 }
 await page.locator('[data-base-choice="#25272b"]').click();await page.keyboard.press('ArrowRight');
 assert.equal(await baseHex.inputValue(),'#18304A');
 await baseHex.fill('#445566');await baseHex.press('Enter');
 assert.equal(await page.locator('[data-base-choice][aria-checked=true]').count(),0,'arbitrary base colors clear the preset selection');
 for(const [color,mode] of [['#EEE7DE','light'],['#18304A','dark']]) {
  await baseHex.fill(color);await baseHex.press('Enter');
  assert.equal(await theme(),mode);assert.equal(await page.locator('html').getAttribute('data-custom-theme'),'');
  assert.equal(await page.locator('html').getAttribute('data-accent'),accentPreference);
  assert.equal(await page.locator('[data-theme-choice=custom]').getAttribute('aria-checked'),'true');
  await peer.waitForFunction(color=>document.querySelector('#theme-base-hex').value===color,color);
  assert.deepEqual(await evidence(),customBefore,'base edits preserve video pixels, marks and layout');
  const colors=await page.locator('html').evaluate(e=>{const style=getComputedStyle(e);return ['--surface','--surface-panel','--text','--accent'].map(token=>style.getPropertyValue(token).trim());});
  const early=await context.newPage();await early.route('**/assets/*.js',route=>route.abort());await early.goto(base);
  assert.equal(await early.locator('html').getAttribute('data-custom-theme'),'');
  assert.deepEqual(await early.locator('html').evaluate(e=>{const style=getComputedStyle(e);return ['--surface','--surface-panel','--text','--accent'].map(token=>style.getPropertyValue(token).trim());}),colors,'custom palette matches before app modules load');await early.close();
  await page.locator('#settings').screenshot({path:artifact(`voidplayer-custom-base-${mode}-${name}.png`)});
  await page.setViewportSize({width:390,height:700});
  assert.equal(await page.locator('#settings-pane-appearance').evaluate(e=>e.scrollWidth>e.clientWidth),false);
  await page.locator('#settings').screenshot({path:artifact(`voidplayer-custom-base-mobile-${mode}-${name}.png`)});await page.setViewportSize({width:1280,height:900});
  await page.waitForFunction(expected=>{const actual=document.querySelector('#stage-A').getBoundingClientRect();return actual.x===expected.x&&actual.y===expected.y&&actual.width===expected.width&&actual.height===expected.height;},customBefore.stage);
 }
 const cached=await page.evaluate(()=>localStorage.getItem('voidplayer.custom-theme'));
 await baseHex.fill('#oops');await baseHex.press('Enter');assert.equal(await baseHex.getAttribute('aria-invalid'),'true');
 assert.equal(await page.evaluate(()=>localStorage.getItem('voidplayer.custom-theme')),cached);
 await baseHex.press('Escape');assert.equal(await baseHex.inputValue(),'#18304A');assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.locator('[data-theme-choice=light]').click();assert.equal(await page.locator('#theme-base-controls').isVisible(),false);assert.equal(await page.locator('html').getAttribute('data-custom-theme'),null);
 await page.locator('[data-theme-choice=custom]').click();assert.equal(await baseHex.inputValue(),'#18304A');
 await page.locator('#theme-base-picker').evaluate(e=>{e.value='#204032';e.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await baseHex.inputValue(),'#204032');
 assert.equal(await page.locator('[data-base-choice][aria-checked=true]').count(),0);
 await peer.waitForFunction(()=>document.querySelector('#theme-base-hex').value==='#204032');
 await peer.reload();await peer.waitForFunction(()=>window.voidPlayer);assert.equal(await peer.locator('[data-theme-choice=custom]').getAttribute('aria-checked'),'true');assert.equal(await peer.locator('#theme-base-hex').inputValue(),'#204032');
 const admin=await context.newPage();await admin.goto(new URL('/admin',base).href);await admin.waitForFunction(()=>document.documentElement.hasAttribute('data-custom-theme'));assert.equal(await admin.locator('html').evaluate(e=>getComputedStyle(e).getPropertyValue('--surface').trim()),await page.locator('html').evaluate(e=>getComputedStyle(e).getPropertyValue('--surface').trim()));await admin.close();
 await page.emulateMedia({contrast:'more'});
 const readable=await page.locator('.transport').evaluate(e=>({fill:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e).backdropFilter||getComputedStyle(e).webkitBackdropFilter,solid:getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()}));
 assert.equal(readable.filter,'none');assert.ok(readable.solid.startsWith('#'));
 await page.emulateMedia({contrast:'no-preference'});await page.locator('[data-theme-choice=system]').click();
 assert.equal(await page.locator('html').getAttribute('data-custom-theme'),null);await page.locator('#settings-close').click();
 await peer.close();assert.deepEqual(errors,[]);
 // Blocked storage still permits an in-memory explicit selection.
 const isolated=await newContext({colorScheme:'dark'});
 await isolated.addInitScript(()=>{Object.defineProperty(Storage.prototype,'getItem',{value(){throw new Error('blocked');}});Object.defineProperty(Storage.prototype,'setItem',{value(){throw new Error('blocked');}});Object.defineProperty(Storage.prototype,'removeItem',{value(){throw new Error('blocked');}});});
 const restricted=await isolated.newPage();await restricted.goto(base);assert.equal(await restricted.locator('html').getAttribute('data-theme'),'dark');
 await restricted.locator('#settings-open').click();await restricted.locator('[data-theme-choice=light]').click();assert.equal(await restricted.locator('html').getAttribute('data-theme'),'light');
 await restricted.locator('#accent-hex').fill('#246ABC');await restricted.locator('#accent-hex').press('Enter');
 assert.equal(await restricted.locator('html').getAttribute('data-accent'),'custom');
 await restricted.locator('[data-theme-choice=custom]').click();await restricted.locator('#theme-base-hex').fill('#18304A');await restricted.locator('#theme-base-hex').press('Enter');assert.equal(await restricted.locator('html').getAttribute('data-custom-theme'),'');assert.equal(await restricted.locator('html').getAttribute('data-theme'),'dark');
 console.log(`PASS ${name}: system/manual/reload/early paint/storage sync, blocked storage, contrast, unchanged video/marks/layout, dark palette and high contrast`);
});
