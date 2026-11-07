import { chooseTestGuest } from './test-identity.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { advanceAdminPollClock } from './testing/admin-poll-clock.mjs';
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-admin-browser-'));
const browserName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
let service, browser;
try {
  const media = path.join(temporary, '本机媒体'); await mkdir(media); await writeFile(path.join(media, 'sample.mp4'), Buffer.alloc(4 * 1024 * 1024, 51));
  for (let i=0;i<61;i++) await mkdir(path.join(media,`folder-${String(i).padStart(3,'0')}`));
  await mkdir(path.join(media,'z-branch','leaf'),{recursive:true});
  await copyFile(path.join(root,'fixtures/video/ci_h264_smoke.mp4'),path.join(media,'z-branch','leaf','nested.mp4'));
  const extra = path.join(temporary, 'shared-storage', '嵌套的制作素材目录'); await mkdir(extra, { recursive: true }); await writeFile(path.join(extra, 'new.mp4'), 'new');
  const file = path.join(temporary, 'voidplayer.config.json');
  await writeFile(file, JSON.stringify({ mediaRoots: [{ id: 'local', name: '本机媒体', path: media }, { id: 'offline', name: '网络归档', path: path.join(temporary, 'offline-mount') }], staticDir: path.join(root, 'dist'), dataDir: 'data', logsDir: 'logs', indexWatch: false }));
  const config = await loadConfig([], 'production', temporary); config.port = 0;
  service = await startService(config, true, { version: '0.1.0-preview', revision: 'browser-check' });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await service.library.refresh();
  const uploaded = await fetch(base + '/api/logs', { method: 'POST', headers: { origin: base, 'x-voidplayer-action': 'log', 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'voidplayer-web-log', sessionId: 'admin-browser', events: [{ type: 'test', text: '<script>alert(1)</script>' }] }) });
  const log = await uploaded.json(); assert.equal(uploaded.status, 201);
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({locale:'zh-CN',  viewport: { width: 1200, height: 820 }, reducedMotion: 'reduce', colorScheme: 'light' });
  const player = await context.newPage(); const errors = [],clockTrace=[];let clockPhase='real-ui';
  context.on('requestfailed',request=>{let owner='unknown';try{owner=request.frame().page()===player?'player':'admin';}catch{}clockTrace.push({phase:clockPhase,event:'requestfailed',page:owner,url:request.url(),failure:request.failure(),at:Date.now()});});
  const observeErrors = (target, owner) => target.on('pageerror', error => {
    errors.push(error.message);
    clockTrace.push({ phase: clockPhase, event: 'pageerror', page: owner, url: target.url(), message: error.message, stack: error.stack, at: Date.now() });
  });
  context.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/library/browse') return;
    let frame = 'unavailable'; try { frame = request.frame().url(); } catch {}
    clockTrace.push({ phase: clockPhase, event: 'library-request', url: request.url(), frame, origin: request.headers().origin ?? null, at: Date.now() });
  });
  context.on('response', response => {
    if (new URL(response.url()).pathname === '/api/library/browse') clockTrace.push({ phase: clockPhase, event: 'library-response', url: response.url(), status: response.status(), allowOrigin: response.headers()['access-control-allow-origin'] ?? null, at: Date.now() });
  });
  player.on('framenavigated', frame => { if (frame === player.mainFrame()) clockTrace.push({ phase: clockPhase, event: 'player-navigation', url: frame.url(), at: Date.now() }); });
  observeErrors(player, 'player');
  await player.goto(base); await chooseTestGuest(player); await player.waitForFunction(() => document.getElementById('server-status')?.dataset.state === 'connected');
  await player.locator('#server-status').hover();
  await player.locator('#control-tooltip').filter({ hasText: '打开服务管理' }).waitFor({ state: 'visible' });
  let [page] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); observeErrors(page, 'admin-first');
  await page.waitForURL(base + '/admin'); await page.locator('#identity').filter({ hasText: '访客' }).waitFor();
  assert.equal(await player.url(), base + '/');
  // Returning to an existing player must retain its in-memory review and tab.
  await player.evaluate(() => { window.adminReturnMarker = 'preserve-review'; });
  assert.equal(await page.evaluate(() => !!window.opener), true);
  // The synchronous handler closes the tab before click's protocol reply can
  // arrive. Accept only that expected close error; still require the close
  // event and the original live player with its unchanged in-memory marker.
  const returned = page.waitForEvent('close');
  await Promise.all([returned, page.getByRole('link', { name: '返回播放器', exact: true }).click().catch(async error => {
    if (!String(error).includes('Target page, context or browser has been closed')) throw error;
    await returned;
  })]);
  assert.equal(context.pages().length, 1);
  assert.equal(await player.evaluate(() => window.adminReturnMarker), 'preserve-review');
  // The library's own management entry preserves the live player and opens the library pane.
  await player.locator('#toggle-sources').click();
  const [managed] = await Promise.all([context.waitForEvent('page'),player.locator('#library-manage').click()]);
  observeErrors(managed,'admin-library'); await managed.waitForURL(base + '/admin#library');
  const embedded = managed.locator('#admin-library-browser');
  const active = embedded.locator('[data-library-view-surface]:not([hidden])');
  await active.locator('.library-mount[data-root-id=local]').waitFor();
  assert.equal(await managed.locator('#language-choice').isVisible(),false,'language controls do not occupy the top of every page');
  assert.ok(await managed.locator('.admin-library-card').evaluate(el => Math.abs(el.getBoundingClientRect().height-innerHeight*.8)<1),'library card leaves space for scrolling the surrounding page');
  const mountedStyle = row => row.evaluate(el => {
    const s=getComputedStyle(el), box=el.querySelector('.source-thumb').getBoundingClientRect(), glyph=el.querySelector('.source-thumb .icon').getBoundingClientRect();
    return {padding:s.padding,font:s.fontSize,thumb:[box.width,box.height],glyph:[glyph.width,glyph.height].map(value => Math.round(value*100)/100)};
  });
  await player.locator('#source-list .library-mount[data-root-id=local]').waitFor();
  assert.deepEqual(await mountedStyle(active.locator('.library-mount[data-root-id=local]')),await mountedStyle(player.locator('#source-list .library-mount[data-root-id=local]')),'admin reuses the player row density and icon geometry');
  await managed.locator('[data-pane=preferences]').click();
  assert.equal(await managed.locator('#pane-preferences #language-choice').isVisible(),true);
  await managed.locator('#language-choice').click(); await managed.locator('#language-choice-menu [data-value=en]').click();
  await managed.waitForFunction(() => document.documentElement.lang==='en');
  assert.equal(await managed.locator('[data-pane=preferences]').innerText(),'Preferences');
  await managed.locator('#language-choice').click(); await managed.locator('#language-choice-menu [data-value="zh-CN"]').click();
  await managed.waitForFunction(() => document.documentElement.lang==='zh-CN');
  await managed.locator('[data-pane=library]').click();
  assert.equal(await embedded.getAttribute('data-library-view'),'columns','administration defaults to column view');
  assert.equal(await embedded.locator('details, .source-group-heading, [id*=library-recents]').count(),0,'administration has no folding controls, root headings or recent history');
  const viewChoice=embedded.locator('#admin-library-view'), addressSurface=embedded.locator('#library-navigation');
  const addressFill=() => addressSurface.evaluate(el => {
    getComputedStyle(el).backgroundColor;
    for(const animation of el.getAnimations())animation.finish();
    return getComputedStyle(el).backgroundColor;
  });
  await managed.mouse.move(0,0); await embedded.locator('#library-location').evaluate(el => el.blur());
  const restingAddress=await addressFill();
  await viewChoice.hover();
  assert.equal(await addressFill(),restingAddress,'hovering the view chooser leaves the address field at rest');
  await viewChoice.focus();
  assert.equal(await addressSurface.evaluate(el => el.matches(':focus-within')),false,'view chooser focus is independent of the address field');
  const choiceBox=await viewChoice.boundingBox(), addressBox=await addressSurface.boundingBox();
  assert.equal(Math.round(choiceBox.x-addressBox.x-addressBox.width),4,'the standalone view chooser has a four-pixel gap');
  await embedded.locator('#source-tools').screenshot({path:`/tmp/voidplayer-admin-view-control-${browserName}.png`});
  const chooseView = async value => {
    await managed.locator('#admin-library-view').click();
    await managed.locator(`#admin-library-view-menu [data-value=${value}]`).click();
    await managed.waitForFunction(value => document.querySelector('#admin-library-browser').dataset.libraryView===value,value);
  };
  const goLibrary = async value => {
    await embedded.locator('#library-location').fill(value); await embedded.locator('#library-location').press('Enter');
    await managed.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy')==='false');
  };
  const offsets=[];
  managed.on('request',request => {
    const u=new URL(request.url());
    if(u.pathname==='/api/library/browse'&&u.searchParams.get('root')==='local'&&!u.searchParams.get('directory'))offsets.push(Number(u.searchParams.get('offset')??0));
  });
  await goLibrary('library:local/z-branch/leaf');
  await active.locator('.library-column[data-directory="z-branch/leaf"] .source-file').waitFor();
  await active.locator('.library-column[data-root=local][data-directory=""] .library-column-selected').waitFor();
  assert.ok(offsets.includes(60),'a direct deep link loads the selected ancestor beyond its first directory page');
  assert.equal(await active.locator('.library-column').count(),4,'root and each directory remain visible as separate columns');
  assert.equal(await active.locator('.library-column-selected').count(),3);
  assert.ok(await active.locator('.library-column[data-root=local][data-directory=""] .library-column-selected').evaluate(row => {
    const box=row.getBoundingClientRect(), column=row.closest('.library-column').getBoundingClientRect();
    return box.top>=column.top-1&&box.bottom<=column.bottom+1;
  }),'a selected ancestor discovered on a later page is revealed in its column');
  for (const theme of ['dark','light']) {
    await player.evaluate(theme => localStorage.setItem('voidplayer.theme',theme),theme);
    await managed.waitForFunction(theme => document.documentElement.dataset.theme===theme,theme);
    for (const row of await active.locator('.library-column-selected').all()) {
      const colors=await row.evaluate(el => ({text:getComputedStyle(el).color,icon:getComputedStyle(el.querySelector('.library-folder-icon')).color,fill:getComputedStyle(el.querySelector('.source-thumb')).background}));
      assert.equal(colors.icon,colors.text,`${theme}: selected mount/folder icons follow their text accent`);
      const changed=await row.evaluate(el => {
        el.style.setProperty('--accent','rgb(180, 70, 20)');
        const value={icon:getComputedStyle(el.querySelector('.library-folder-icon')).color,fill:getComputedStyle(el.querySelector('.source-thumb')).background};
        el.style.removeProperty('--accent'); return value;
      });
      assert.equal(changed.icon,'rgb(180, 70, 20)');
      assert.notEqual(changed.fill,colors.fill,'the selected thumbnail background responds to a changed theme accent');
    }
    await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-library-selected-icons-${theme}-${browserName}.png`});
  }
  const widths = () => active.locator('.library-column').evaluateAll(columns => columns.map(column => Math.round(column.getBoundingClientRect().width)));
  const scrollColumns = async x => {
    await embedded.locator('#source-list').evaluate((list,x) => {list.scrollLeft=x;},x);
    await managed.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await managed.locator('.admin-library-card').scrollIntoViewIfNeeded();
  await scrollColumns(0);
  assert.equal(await active.locator('.library-column-splitter').count(),4,'each column has an independent resize edge');
  assert.ok(await active.locator('.library-column-splitter').first().evaluate(el => el.getBoundingClientRect().width===1));
  assert.equal(await active.evaluate(el => getComputedStyle(el).columnGap),'0px','columns meet at a splitter instead of padded gutters');
  const columnSplitter=active.locator('.library-column-splitter').first(), panelSplitter=player.locator('#sources-resize');
  const splitterSurface = handle => handle.evaluate(el => {
    getComputedStyle(el,'::after').backgroundColor;
    for(const animation of el.getAnimations({subtree:true}))animation.finish();
    const line=getComputedStyle(el,'::after'), hit=getComputedStyle(el,'::before');
    return {fill:line.backgroundColor,width:line.width,transition:line.transitionProperty,duration:line.transitionDuration,hit:hit.width};
  });
  await player.mouse.move(0,0); await managed.mouse.move(0,0);
  const idleSplitter=await splitterSurface(panelSplitter);
  assert.deepEqual(await splitterSurface(columnSplitter),idleSplitter,'column and panel splitters share the same idle line, hit area and transition');
  assert.equal(await columnSplitter.evaluate(el => getComputedStyle(el,'::before').backgroundSize),'1px 100%','administration keeps a one-pixel idle divider on each column edge');
  await panelSplitter.hover(); await columnSplitter.hover();
  const hoverSplitter=await splitterSurface(panelSplitter);
  assert.notEqual(hoverSplitter.fill,idleSplitter.fill,'the shared line fades from transparent to the theme accent');
  assert.deepEqual(await splitterSurface(columnSplitter),hoverSplitter,'hover uses the same accent line thickness and animation as the viewport edge');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-shared-splitter-${browserName}.png`});
  await player.mouse.move(0,0); await managed.mouse.move(0,0);
  const resizeColumn = async (index,delta,cancel=false) => {
    const handle=active.locator('.library-column-splitter').nth(index), box=await handle.boundingBox();
    await managed.mouse.move(box.x+box.width/2,box.y+24); await managed.mouse.down();
    await managed.mouse.move(box.x+box.width/2+delta,box.y+24,{steps:4});
    if(cancel)await managed.keyboard.press('Escape');
    await managed.mouse.up();
  };
  await resizeColumn(0,40);
  assert.deepEqual(await widths(),[320,280,280,280],'dragging one splitter only changes its own column');
  const capacity = active.locator('.library-mount[data-root-id=local] .source-storage');
  await resizeColumn(0,-140);
  const capacityGeometry=await capacity.evaluate(meta => {
    const box=meta.getBoundingClientRect(), available=meta.querySelector('.source-storage-available').getBoundingClientRect();
    const total=meta.querySelector('.source-storage-total').getBoundingClientRect();
    return {box:box.toJSON(),available:available.toJSON(),total:total.toJSON(),text:meta.textContent};
  });
  assert.ok(capacityGeometry.available.right<=capacityGeometry.box.right+1&&capacityGeometry.available.bottom<=capacityGeometry.box.bottom+1&&capacityGeometry.total.top>=capacityGeometry.box.bottom,JSON.stringify(capacityGeometry));
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-library-storage-narrow-${browserName}.png`});
  await resizeColumn(0,200);
  assert.ok(await capacity.evaluate(meta => meta.querySelector('.source-storage-total').getBoundingClientRect().bottom<=meta.getBoundingClientRect().bottom+1),'widening a column restores the complete capacity');
  await resizeColumn(0,-60);
  await active.locator('.library-column-splitter').nth(2).focus(); await managed.keyboard.press('ArrowRight');
  assert.deepEqual(await widths(),[320,280,296,280],'splitters also resize with the keyboard');
  await resizeColumn(1,50,true);
  assert.deepEqual(await widths(),[320,280,296,280],'Escape cancels a resize without changing the saved preference');
  await goLibrary('library:local/folder-000');
  await active.locator('.library-column[data-directory="folder-000"]').waitFor();
  assert.deepEqual(await widths(),[320,280,296],'a different folder at the same depth retains the width by column index');
  await goLibrary('library:local/z-branch/leaf');
  await active.locator('.library-column[data-directory="z-branch/leaf"] .source-file').waitFor();
  assert.deepEqual(await widths(),[320,280,296,280]);
  await scrollColumns(50);
  const ancestor=active.locator('.library-column[data-root=local][data-directory=""]');
  await ancestor.evaluate(el => {el.scrollTop=0;});
  const ancestorBox=await ancestor.boundingBox();
  await managed.mouse.move(ancestorBox.x+40,ancestorBox.y+80); await managed.mouse.wheel(90,4);
  await managed.waitForFunction(() => document.querySelector('#source-list').scrollLeft>=135);
  assert.equal(await ancestor.evaluate(el => el.scrollTop),0,'horizontal two-finger deltas move columns instead of their vertical list');
  const horizontal=await embedded.locator('#source-list').evaluate(el => el.scrollLeft);
  await managed.mouse.wheel(0,120);
  await managed.waitForFunction(() => document.querySelector('.library-column[data-root=local][data-directory=""]').scrollTop>0);
  assert.equal(await embedded.locator('#source-list').evaluate(el => el.scrollLeft),horizontal,'vertical wheel input remains in its column');
  await scrollColumns(0);
  const horizontalRail=embedded.locator('.library-horizontal-scrollbar');
  await horizontalRail.waitFor({state:'visible'});
  await horizontalRail.scrollIntoViewIfNeeded();
  const thumbBox=await horizontalRail.locator('span').boundingBox();
  await managed.mouse.move(thumbBox.x+thumbBox.width/2,thumbBox.y+thumbBox.height/2); await managed.mouse.down();
  await managed.mouse.move(thumbBox.x+thumbBox.width/2+70,thumbBox.y+thumbBox.height/2); await managed.mouse.up();
  assert.ok(await embedded.locator('#source-list').evaluate(el => el.scrollLeft>50),'the bottom scrollbar can be dragged');
  await horizontalRail.focus(); await managed.keyboard.press('Home');
  assert.equal(await embedded.locator('#source-list').evaluate(el => el.scrollLeft),0);
  await managed.setViewportSize({width:320,height:820});
  await managed.waitForFunction(() => document.querySelector('.library-column').getBoundingClientRect().width<=document.querySelector('#source-list').clientWidth);
  await managed.setViewportSize({width:1200,height:820});
  await managed.waitForFunction(() => Math.round(document.querySelector('.library-column').getBoundingClientRect().width)===320);
  assert.deepEqual(await widths(),[320,280,296,280],'responsive clamping never overwrites the desired width');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-admin-columns-deep-${browserName}.png`});
  await active.locator('.library-column[data-root=local][data-directory=""] .library-column-selected').click();
  await active.locator('.library-column[data-directory="z-branch"] .library-folder').click();
  await active.locator('.library-column[data-directory="z-branch/leaf"] .source-file').waitFor();
  await chooseView('list');
  assert.equal(await embedded.locator('#library-location').inputValue(),'leaf');
  assert.equal(await active.locator('.source-file .filename').innerText(),'nested.mp4');
  await embedded.locator('#library-location').focus(); await embedded.locator('#library-location').fill('nested');
  await managed.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy')==='false');
  await chooseView('columns');
  await active.locator('.library-column').last().locator('.source-file').waitFor();
  assert.equal(await embedded.locator('#library-location').inputValue(),'nested','view changes retain the directory search');
  await embedded.locator('.crumbs-back').click();
  await managed.waitForFunction(() => document.querySelector('#library-location').value==='z-branch');
  await embedded.locator('.crumbs-forward').click();
  await managed.waitForFunction(() => document.querySelector('#library-location').value==='nested');
  await active.locator('.library-column').last().locator('.source-file').waitFor();
  await managed.setViewportSize({width:390,height:820});
  await active.locator('.library-column').last().scrollIntoViewIfNeeded();
  assert.equal(await managed.evaluate(() => document.documentElement.scrollWidth<=innerWidth),true,'columns scroll within the card at narrow widths');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-admin-columns-narrow-${browserName}.png`});
  await managed.setViewportSize({width:1200,height:820});
  await goLibrary('library:local');

  await active.locator('.source-file').filter({hasText:'sample.mp4'}).waitFor();
  assert.equal(await active.locator('.source-meta-origin').count(),0,'directory files do not repeat their library name');
  await active.locator('.source-file').click({button:'right'});
  assert.deepEqual(await managed.locator('#library-file-menu button').allTextContents(),['在播放器中浏览','拷贝文件名','拷贝绝对路径','拷贝媒体库路径','下载文件']);
  await managed.keyboard.press('Escape');
  const pagesBeforeClick=context.pages().length;
  await active.locator('.source-open').click();
  assert.equal(context.pages().length,pagesBeforeClick,'single-clicking an administration file row does not open a player');
  assert.equal(await player.evaluate(() => window.voidPlayer.getState().tracks.length),0);
  await managed.emulateMedia({reducedMotion:'no-preference'});
  const pressedFile=active.locator('.source-file');
  const sampleFileFill = async action => {
    await pressedFile.evaluate(el => {
      window.filePressSamples=[];
      const sample=() => {
        window.filePressSamples.push({fill:getComputedStyle(el).backgroundColor,inner:getComputedStyle(el.querySelector('.source-open')).backgroundColor});
        window.filePressFrame=requestAnimationFrame(sample);
      };
      sample();
    });
    await action(); await managed.waitForTimeout(320);
    return managed.evaluate(() => {cancelAnimationFrame(window.filePressFrame);return window.filePressSamples;});
  };
  for (const theme of ['dark','light']) {
    await player.evaluate(theme => localStorage.setItem('voidplayer.theme',theme),theme);
    await managed.waitForFunction(theme => document.documentElement.dataset.theme===theme,theme);
    await pressedFile.locator('.filename').hover(); await managed.waitForTimeout(320);
    const hoverFill=await pressedFile.evaluate(el => getComputedStyle(el).backgroundColor);
    const press=await sampleFileFill(() => managed.mouse.down());
    const heldFill=press.at(-1).fill;
    const release=await sampleFileFill(() => managed.mouse.up());
    assert.notEqual(heldFill,'rgba(0, 0, 0, 0)',`${theme}: pressing a file keeps a visible fill instead of exposing the dark backing`);
    assert.notEqual(heldFill,hoverFill,`${theme}: pressing is distinct from hover`);
    assert.equal(release.at(-1).fill,hoverFill,`${theme}: releasing returns to the hovered row`);
    for (const [phase,samples] of [['press',press],['release',release]]) {
      assert.ok(new Set(samples.map(sample => sample.fill)).size>2,`${theme}: ${phase} transitions the outer row without a one-frame jump`);
      assert.ok(samples.every(sample => sample.inner==='rgba(0, 0, 0, 0)'),`${theme}: ${phase} never adds a second inner highlight`);
    }
  }
  await managed.emulateMedia({reducedMotion:'reduce'});
  await goLibrary('library:local/z-branch/leaf');
  const nestedFile=active.locator('.source-file').filter({hasText:'nested.mp4'});
  await nestedFile.waitFor();
  await nestedFile.click({button:'right'});
  const [destination] = await Promise.all([context.waitForEvent('page'),managed.locator('#library-file-menu [data-action=browse-in-player]').click()]);
  await destination.waitForFunction(() => !!window.voidPlayer);
  assert.equal(new URL(destination.url()).searchParams.get('library'),'local');
  assert.equal(new URL(destination.url()).searchParams.has('root'),false);
  await destination.waitForFunction(() => {
    const state=window.voidPlayer.getState();
    return !state.busy&&state.tracks.length===1&&!!state.tracks[0].frame;
  });
  const opened=await destination.evaluate(() => window.voidPlayer.getState());
  assert.equal(opened.tracks[0].name,'z-branch/leaf/nested.mp4');
  assert.equal(opened.tracks[0].source.id,new URL(destination.url()).searchParams.get('media'));
  assert.equal(new URL(opened.tracks[0].source.url,destination.url()).searchParams.get('v'),new URL(destination.url()).searchParams.get('v'));
  assert.equal(opened.playing,false,'the explicit file link presents the chosen file without autoplay');
  assert.equal(new URL(destination.url()).searchParams.get('dir'),'z-branch/leaf');
  const sourceSplitter=destination.locator('#sources-resize'), sourcePanel=destination.locator('#sources-panel');
  assert.equal(await sourceSplitter.isVisible(),true,'an initially open library panel exposes its splitter without resizing the window or toggling the panel');
  await sourceSplitter.hover();
  assert.equal(await sourceSplitter.evaluate(el => {
    const box=el.getBoundingClientRect();
    return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('#sources-resize')===el&&el.matches(':hover');
  }),true,'the cold-link splitter receives pointer hover instead of the panel underneath');
  const initialPanelWidth=(await sourcePanel.boundingBox()).width, splitterBox=await sourceSplitter.boundingBox();
  const widthDelta=initialPanelWidth+24<=Number(await sourceSplitter.getAttribute('aria-valuemax'))?24:-24;
  await destination.mouse.down();
  await destination.mouse.move(splitterBox.x+splitterBox.width/2-widthDelta,splitterBox.y+splitterBox.height/2,{steps:4});
  await destination.mouse.up();
  assert.ok(Math.abs((await sourcePanel.boundingBox()).width-initialPanelWidth-widthDelta)<1,'a cold-link panel can be dragged immediately');

  assert.equal(await player.evaluate(() => window.adminReturnMarker),'preserve-review');
  await destination.close();
  await goLibrary('library:/');
  await chooseView('list'); await managed.reload();
  await managed.waitForFunction(() => document.querySelector('#admin-library-browser')?.dataset.libraryView==='list');
  await active.locator('.library-mount[data-root-id=local]').waitFor();
  await chooseView('columns');
  assert.deepEqual(await widths(),[320],'column preferences survive reload');
  await goLibrary('library:local/z-branch/leaf');
  assert.deepEqual(await widths(),[320,280,296,280]);
  await goLibrary('library:/');
  for (const theme of ['dark','light']) {
    await player.evaluate(theme => localStorage.setItem('voidplayer.theme',theme),theme);
    await managed.waitForFunction(theme => document.documentElement.dataset.theme===theme,theme);
    await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-admin-shared-library-${theme}-${browserName}.png`});
  }
  await managed.close(); await player.locator('#toggle-sources').click();
  const direct = await context.newPage(); await direct.goto(base + '/admin');
  await direct.getByRole('link', { name: '返回播放器', exact: true }).click(); await direct.waitForURL(base + '/');
  assert.equal(context.pages().length, 2, 'direct admin visits return within their current tab'); await direct.close();
  const otherPlayer = await context.newPage(); await otherPlayer.goto(base);
  const [orphan] = await Promise.all([context.waitForEvent('page'), otherPlayer.locator('#server-status').click()]);
  await orphan.waitForURL(base + '/admin'); await otherPlayer.close();
  await orphan.getByRole('link', { name: '返回播放器', exact: true }).click(); await orphan.waitForURL(base + '/'); await orphan.close();
  [page] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); observeErrors(page, 'admin-second');
  await page.locator('#identity').filter({ hasText: '访客' }).waitFor();

  await page.waitForFunction(() => document.getElementById('analysis-concurrency')?.value === '8');
  const analysisThreads = page.getByLabel('解码线程上限');
  const analysisContexts = page.getByLabel('帧上下文数');
  assert.equal(await analysisThreads.inputValue(), '1');
  assert.equal(await analysisContexts.inputValue(), '1');
  await analysisContexts.fill('2');
  assert.equal(await page.locator('#analysis-resource-save').isDisabled(), true);
  await analysisThreads.fill('3');
  await page.getByLabel('服务端分析并发数').fill('12');
  await page.getByRole('button', { name: '保存分析配置', exact: true }).click();
  await page.locator('#analysis-resource-save-state').filter({ hasText: '分析配置已保存' }).waitFor();
  const analysisConfig = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(analysisConfig.analysisConcurrency, 12);
  assert.deepEqual(analysisConfig.analysisDecoder, { threads: 3, contexts: 2 });
  assert.equal((await (await fetch(base + '/api/admin/status')).json()).analysis.concurrency, 12);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('analysis-concurrency')?.value === '12');
  assert.equal(await analysisThreads.inputValue(), '3');
  assert.equal(await analysisContexts.inputValue(), '2');
  await page.locator('#quality-resource-reload').click();
  await page.waitForFunction(()=>document.querySelector('[data-quality-resource="concurrency"]')?.value==='1');
  await page.locator('[data-quality-resource="concurrency"]').fill('2');
  await page.locator('[data-quality-resource="cambi"]').fill('2');
  await page.locator('[data-quality-resource="memoryBytes"]').fill('4096');
  await page.locator('#quality-resource-save').click();
  await page.waitForFunction(()=>document.querySelector('#quality-resource-history')?.children.length===1);
  const scoringConfig=JSON.parse(await readFile(file,'utf8'));
  assert.equal(scoringConfig.qualityResources.concurrency,2);assert.equal(scoringConfig.qualityResources.perExecutor.cambi,2);
  assert.ok(scoringConfig.qualityResourceHistory[0].actor.id);assert.equal(scoringConfig.qualityResourceHistory[0].before.concurrency,1);
  await page.locator('[data-quality-resource="concurrency"]').fill('99');
  assert.equal(await page.locator('#quality-resource-save').isDisabled(),true);
  await page.locator('#quality-resource-reload').click();
  await page.waitForFunction(()=>document.querySelector('[data-quality-resource="concurrency"]')?.value==='2');
  await page.getByLabel('服务端分析并发数').fill('33');
  assert.equal(await page.locator('#analysis-resource-save').isDisabled(), true);
  await page.locator('#analysis-resource-reload').click();
  await page.waitForFunction(() => document.getElementById('analysis-concurrency')?.value === '12');

  assert.equal(await page.evaluate(() => { const rows = [...document.querySelectorAll('#pane-overview .admin-properties > div')]; return rows.every((r, i) => !i || r.getBoundingClientRect().top > rows[i-1].getBoundingClientRect().top); }), true, 'properties must remain a single ordered list');
  await page.screenshot({ path: `/tmp/voidplayer-admin-overview-light-${browserName}.png` });
  await page.route('**/api/admin/status?view=overview', route => route.fulfill({ status: 503, json: { error: '服务暂不可用，请重试' } }));
  await page.locator('#refresh-status').click();
  await page.locator('#admin-message').filter({ hasText: '服务暂不可用' }).waitFor();
  await page.screenshot({ path: `/tmp/voidplayer-admin-status-error-${browserName}.png` });
  await page.unroute('**/api/admin/status?view=overview');
  await page.locator('#refresh-status').click();
  await page.locator('#admin-message').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.getByLabel('目录名称').first().waitFor();
  await page.locator('.admin-root-state').filter({ hasText: '存储离线' }).waitFor();
  const aligned = await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => { const inputs = row.querySelectorAll('input'); return Math.abs(inputs[0].getBoundingClientRect().top - inputs[1].getBoundingClientRect().top) < 1; }));
  assert.equal(aligned, true, 'name and path inputs must align independently of status captions');
  await page.getByLabel('目录名称').first().fill('本机拍摄素材');
  const leavePrompt = page.waitForEvent('dialog');
  const returnClick = page.getByRole('link', { name: '返回播放器', exact: true }).click();
  await (await leavePrompt).dismiss(); await returnClick;
  assert.equal(page.isClosed(), false, 'canceling return preserves unsaved directory edits');
  assert.equal(await page.getByLabel('目录名称').first().inputValue(), '本机拍摄素材');

  // Polling is intentionally observed while editing: it must preserve the input node.
  await page.locator('#refresh-status').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('[data-field=name]')?.value === '本机拍摄素材');
  await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-editing-${browserName}.png` });
  await page.getByLabel('目录名称').last().fill('制作素材'); await page.getByLabel('服务器上的目录路径').last().fill(extra);
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.locator('#root-save-state').filter({ hasText: '目录配置已保存' }).waitFor();
  const stored = JSON.parse(await readFile(file, 'utf8')); assert.equal(stored.mediaRoots.length, 3); assert.equal(stored.mediaRoots[0].id, 'local'); assert.equal(stored.mediaRoots[0].name, '本机拍摄素材');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-light-${browserName}.png` });
  // Cross-tab theme synchronization uses the existing shared browser preference.
  await player.evaluate(() => localStorage.setItem('voidplayer.theme', 'dark'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-dark-${browserName}.png` });
  await page.getByRole('button', { name: '日志', exact: true }).click();
  await page.locator('#log-storage').filter({ hasText: '上传报告：' }).waitFor();
  assert.ok((await page.locator('#log-storage').textContent()).includes('保留到手动删除'));
  assert.ok((await page.locator('#log-storage').textContent()).includes('运行日志：'));
  await page.locator('.admin-log-item').first().click();
  await page.waitForFunction(() => document.getElementById('log-json')?.value.includes('admin-browser'));
  assert.ok((await page.locator('#log-json').inputValue()).includes('<script>'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), log.name);
  assert.equal(await page.locator('#log-json').evaluate(e => e.clientHeight > 350 && e.clientWidth > 500), true, 'log JSON must use the available content area');
  await page.screenshot({ path: `/tmp/voidplayer-admin-logs-dark-${browserName}.png` });
  await page.getByRole('button', { name: '删除选中日志', exact: true }).click(); await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await (await fetch(base + '/api/admin/logs')).json()).entries.length, 1);
  await page.getByRole('button', { name: '删除选中日志', exact: true }).click(); await page.getByRole('button', { name: '删除日志', exact: true }).click();
  await page.locator('#log-list').filter({ hasText: '暂无上传日志' }).waitFor();
  assert.equal((await (await fetch(base + '/api/admin/logs')).json()).entries.length, 0);
  await page.getByRole('button', { name: '测速', exact: true }).click();
  assert.equal((await (await fetch(base + '/api/admin/measurements')).json()).job, null, 'opening the page cannot start traffic');
  assert.equal(await page.locator('#pane-measurements select').count(), 0);
  assert.equal(await page.locator('#measure-result').isVisible(), false, 'unused results stay compact');
  const choose = async (id, value) => {
    await page.locator(`#${id}`).click();
    const menu = page.locator(`#${id}-menu`);
    const triggerBox = await page.locator(`#${id}`).boundingBox(), menuBox = await menu.boundingBox();
    assert.ok(menuBox.width >= triggerBox.width - 1, `${id} menu narrower than trigger`);
    await menu.locator(`[data-value="${value}"]`).click();
  };
  await choose('measure-limit', '64'); await choose('measure-seconds', '5');
  for (const kind of ['download', 'upload', 'storage', 'concurrent']) {
    await choose('measure-kind', kind);
    if (['storage', 'concurrent'].includes(kind)) {
      await page.waitForFunction(() => [...document.querySelectorAll('#measure-media-menu button')].some(option => option.textContent.includes('sample.mp4')));
      await choose('measure-media', await page.locator('#measure-media-menu button').filter({ hasText: 'sample.mp4' }).getAttribute('data-value'));
    }
    await page.getByRole('button', { name: '开始测试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#measure-state')?.textContent.includes('已完成') && !document.querySelector('#measure-start')?.disabled);
    const result = (await (await fetch(base + '/api/admin/measurements')).json()).job;
    assert.equal(result.kind, kind); assert.ok(['limit', 'duration'].includes(result.reason), `${kind}: ${result.reason}`); assert.equal(result.errors, 0);
    assert.ok(result.bytes > 0 && result.bytes <= 64 * 1024 * 1024);
    if (kind !== 'storage') { assert.ok(result.client.bytes > 0); assert.ok(result.client.elapsedMs > 0); }
    assert.ok(!(await page.locator('#measure-rate').textContent()).includes('NaN'));
  }
  await page.screenshot({ path: `/tmp/voidplayer-admin-measure-dark-${browserName}.png` });
  await player.evaluate(() => localStorage.setItem('voidplayer.theme', 'light'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: `/tmp/voidplayer-admin-measure-light-${browserName}.png` });
  // Hold the first browser transfer so cancellation is exercised mid-task,
  // independent of how quickly localhost can exhaust the byte budget.
  await page.route('**/api/admin/measurements/*/transfer', async route => { await new Promise(r => setTimeout(r, 400)); await route.continue().catch(() => {}); });
  await choose('measure-kind', 'download');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await page.getByRole('button', { name: '取消测试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#measure-state')?.textContent.includes('已取消') && !document.querySelector('#measure-start')?.disabled);
  assert.equal((await (await fetch(base + '/api/admin/measurements')).json()).job.activeRequests, 0);
  await page.unroute('**/api/admin/measurements/*/transfer');
  for (const width of [1512, 1280, 720, 390]) {
    await page.setViewportSize({ width, height: 820 });
    for (const name of ['概览', '媒体库', '缓存', '标注', '工作区', '日志', '测速', '首选项']) {
      await page.getByRole('button', { name, exact: true }).click();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.admin-content > section:not([hidden])')].every(e => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(fits, true, `${name} overflows at ${width}px`);
      await page.screenshot({ path: `/tmp/voidplayer-admin-${name}-${width}-${browserName}.png` });
    }
  }
  // New scoring pages share player controls; switching views must preserve drafts
  // and must never create or cancel a background task.
  const qualityCommands = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/quality/')) qualityCommands.push(request.url());
  });
  await page.locator('[data-pane=quality]').click();
  await page.locator('#quality-form [name=x]').fill('24');
  for (const theme of ['light', 'dark']) {
    await player.evaluate(theme => localStorage.setItem('voidplayer.theme', theme), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 820 });
      for (const view of ['single', 'correspondence', 'vmaf', 'cambi', 'ranges', 'xpsnr']) {
        await page.locator(`[data-quality-section=${view}]`).click();
        assert.equal(await page.locator('[data-quality-view]:visible').count(), 1);
        assert.equal(await page.locator(`[data-quality-view=${view}]`).isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#pane-quality').scrollWidth <= document.querySelector('#pane-quality').clientWidth + 1), true, `${view} ${theme} overflows at ${width}`);
      }
      await page.locator('[data-quality-section=single]').click();
      assert.equal(await page.locator('#quality-form [name=x]').inputValue(), '24');
      const checkbox = await page.locator('#quality-ssim-enabled').boundingBox();
      assert.ok(checkbox.width <= 20 && checkbox.height <= 20, 'checkbox keeps player-sized control');
      await page.screenshot({path: `/tmp/voidplayer-quality-${theme}-${width}-${browserName}.png`});
    }
  }
  await page.locator('[data-quality-section=vmaf]').focus();
  await page.keyboard.press('Enter');
  await page.reload();
  assert.equal(await page.locator('[data-quality-view=vmaf]').isVisible(), true, 'reload restores selected workflow');
  assert.equal(qualityCommands.length, 0, 'navigation does not create or cancel tasks');
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-narrow-${browserName}.png` });
  assert.equal(await page.getByRole('link', { name: '返回播放器', exact: true }).isVisible(), true, 'mobile keeps a return link');
  const backBox = await page.getByRole('link', { name: '返回播放器', exact: true }).boundingBox();
  assert.ok(backBox.x >= 0 && backBox.x + backBox.width <= 390, 'mobile return link stays inside the viewport');
  // The entry is always a link, even for a non-admin or an unavailable service.
  await player.waitForLoadState('networkidle');
  await player.clock.install();
  let healthReads = 0;
  await player.route('**/api/health', async route => { healthReads++; await route.fulfill({ json: { service: 'voidplayer-media', capabilities: { admin: false } } }); });
  await player.reload();
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'connected');
  // Settle real library IO before pausing the page clock. Advancing a whole
  // poll interval in one leap can fire an unrelated request's10s abort timer
  // while its actual localhost response is still in flight.
  await player.waitForLoadState('networkidle');
  await player.clock.pauseAt(new Date(Date.now()+1000));
  const advancePoll = () => advanceAdminPollClock(player, ms => clockTrace.push({ phase: clockPhase, event: 'advance', ms, at: Date.now() }));
  const beforeClick = healthReads;
  const [management] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  await management.getByRole('heading', { name: '概览', exact: true }).waitFor();
  await management.locator('#identity').filter({ hasText: '访客' }).waitFor();
  assert.equal(healthReads, beforeClick, 'clicking the entry must not trigger a health check');
  await management.close();
  await player.bringToFront();
  // Capture the polling baseline only after foreground/close-triggered IO,
  // so a visibility probe cannot masquerade as the timer-driven poll.
  await player.waitForLoadState('networkidle');
  const beforePoll = healthReads;
  clockPhase='connected-poll';await advancePoll();
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'connected');
  assert.ok(healthReads > beforePoll, 'connection polling continues automatically');
  await player.route('**/api/health', route => route.fulfill({ status: 503, json: {} }));
  clockPhase='disconnected-poll';await advancePoll();
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'disconnected');
  const [offlineAdmin] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  await offlineAdmin.waitForURL(base + '/admin'); await offlineAdmin.close();
  await player.close();
  await page.bringToFront();
  await page.clock.resume();
  const requestReads = [], overviewReads = [];
  // WebKit can expose a revalidated response as 200 in its browser protocol.
  // Observe the actual server response and the client's conditional header.
  const recordResponses = (request, response) => {
    const pathname = new URL(request.url, base).pathname;
    response.once('finish', () => {
      if (pathname === '/api/admin/requests') requestReads.push({ status: response.statusCode, conditional: !!request.headers['if-none-match'] });
      if (pathname === '/api/admin/status') overviewReads.push(request.url);
    });
  };
  service.server.on('request', recordResponses);
  await page.locator('[data-pane=logs]').click(); await page.locator('[data-log-mode=requests]').click();
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(6500);
  assert.ok(requestReads.some(read => read.status === 304 && read.conditional), 'unchanged request history sends a validator and reuses the current actor snapshot');
  assert.ok(await page.locator('#request-list .admin-request-row').count() > 0, 'the revalidated snapshot stays rendered');
  await page.locator('#request-list .admin-request-row > span:first-child').filter({ hasText: '127.0.0.1' }).first().waitFor();
  assert.equal(overviewReads.length, 0, 'request history does not poll the hidden overview');
  await page.locator('[data-pane=workspaces]').click(); await page.waitForLoadState('networkidle');
  const readsAfterHide = requestReads.length;
  await page.waitForTimeout(4000);
  assert.equal(requestReads.length, readsAfterHide, 'hidden request history stops observing');
  assert.equal(overviewReads.length, 0, 'other management panes do not fetch overview snapshots');
  service.server.off('request', recordResponses);
  console.log('REQUEST_OBSERVATION_EVIDENCE', JSON.stringify({ browserName, statuses: requestReads, hiddenReads: requestReads.length - readsAfterHide, overviewReads: overviewReads.length }));
  if(errors.length)console.error(JSON.stringify({browserName,clockPhase,errors,clockTrace}));
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`PASS admin ${browserName}: new-tab entry, real status, offline roots, persistent root editing, cross-tab theme, JSON/download/delete, four bounded measurements and cancellation, aligned directory fields, status recovery, and 390/720/1200/1280/1512 px layout`);
} finally { await browser?.close(); await service?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
