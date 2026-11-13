import { chooseTestGuest } from './test-identity.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from './testing/browser-engines.mjs';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { advanceAdminPollClock } from './testing/admin-poll-clock.mjs';
import {THUMB_RECIPE_VERSION} from '../shared/thumbnails/contract.ts';
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-admin-browser-'));
const browserName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
let service, browser;
try {
  const media = path.join(temporary, '本机媒体'); await mkdir(media); await writeFile(path.join(media, 'sample.mp4'), Buffer.alloc(4 * 1024 * 1024, 51));
  for (let i=0;i<61;i++) await mkdir(path.join(media,`folder-${String(i).padStart(3,'0')}`));
  await mkdir(path.join(media,'z-branch','leaf'),{recursive:true});
  await mkdir(path.join(media,'z-branch','leaf','target'));
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
  // Preserve the detailed-row geometry setup; viewport-interactions covers the compact default.
  await context.addInitScript(() => { if (localStorage.getItem('voidplayer.library-compact') == null) localStorage.setItem('voidplayer.library-compact', 'false'); });
  const player = await context.newPage(); const errors = [],clockTrace=[];let clockPhase='real-ui';
  // A cached cover exercises browser image dragging without decoding an extra video.
  const cover=await player.evaluate(() => {
    const canvas=document.createElement('canvas');canvas.width=40;canvas.height=24;
    const context=canvas.getContext('2d');context.fillStyle='#d77e35';context.fillRect(0,0,40,24);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
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
  await player.locator('#control-tooltip').filter({ hasText: '打开后端管理页' }).waitFor({ state: 'visible' });
  const tooltip = (await player.locator('#control-tooltip').innerText()).split('\n');
  assert.deepEqual(tooltip.slice(0, 3), ['打开后端管理页', base + '/admin', '状态：在线']);
  assert.equal(tooltip.length, 4); assert.match(tooltip[3], /^RTT：\d+ms$/);
  let [page] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); observeErrors(page, 'admin-first');
  await page.waitForURL(base + '/admin'); await page.locator('#identity').filter({ hasText: '访客' }).waitFor();
  assert.equal(await page.locator('head meta[name="darkreader-lock"]').count(), 1, 'admin retains its native palette');
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
  for (const surface of [player,managed]) assert.equal(await surface.locator('#library-navigation').evaluate(el => el.nextElementSibling?.id),'library-compact','compact is the first control after the address field');
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
  const choiceBox=await viewChoice.boundingBox(), addressBox=await addressSurface.boundingBox(), densityBox=await embedded.locator('#library-compact').boundingBox();
  assert.equal(Math.round(densityBox.x-addressBox.x-addressBox.width),4,'compact density follows the address with a four-pixel gap');
  assert.equal(Math.round(choiceBox.x-densityBox.x-densityBox.width),4,'the view chooser follows compact density with a four-pixel gap');
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
  await active.locator('.library-column[data-root=local][data-directory=""] .library-column-path').waitFor();
  assert.ok(offsets.includes(60),'a direct deep link loads the selected ancestor beyond its first directory page');
  assert.equal(await active.locator('.library-column').count(),4,'root and each directory remain visible as separate columns');
  assert.equal(await active.locator('.library-column-path').count(),3);
  assert.ok(await active.locator('.library-column[data-root=local][data-directory=""] .library-column-path').evaluate(row => {
    const box=row.getBoundingClientRect(), column=row.closest('.library-column').getBoundingClientRect();
    return box.top>=column.top-1&&box.bottom<=column.bottom+1;
  }),'a selected ancestor discovered on a later page is revealed in its column');
  await player.locator('[data-accent-choice=rose]').evaluate(button => button.click());
  for (const theme of ['dark','light']) {
    await player.locator(`[data-theme-choice=${theme}]`).evaluate(button => button.click());
    await managed.waitForFunction(theme => document.documentElement.dataset.theme===theme && document.documentElement.dataset.accent==='rose',theme);
    const mount = player.locator('#source-list .library-mount[data-root-id=local]');
    await mount.hover();
    const playerHover = await mount.evaluate(el => getComputedStyle(el).backgroundColor);
    const folder = active.locator('.library-column[data-directory="z-branch/leaf"] .library-folder').first();
    await folder.hover();
    assert.equal(await folder.evaluate(el => getComputedStyle(el).backgroundColor),playerHover,`${theme}: folder hover matches the player`);
    for (const row of await active.locator('.library-column-path').all()) {
      assert.equal(await row.evaluate(el => getComputedStyle(el).backgroundColor),playerHover,`${theme}: path ancestors use the player hover fill`);
      assert.equal(await row.getAttribute('aria-selected'),'false','path ancestors do not count as selected items');
      assert.equal(await row.evaluate(el => el.classList.contains('library-item-selected')),false);
    }
    const cardFills=await embedded.evaluate(el => ({card:getComputedStyle(el.closest('.admin-library-card')).backgroundColor,
      scan:getComputedStyle(document.querySelector('#roots-form')).backgroundColor,
      layers:[el,...el.querySelectorAll('.library-columns,.library-column,.library-horizontal-scrollbar')].map(node => getComputedStyle(node).backgroundColor)}));
    assert.equal(cardFills.card,cardFills.scan,`${theme}: the library shares the scan card material`);
    assert.ok(cardFills.layers.every(fill => fill==='rgba(0, 0, 0, 0)'),`${theme}: library columns do not obscure their card backing`);
    const chrome=await embedded.evaluate(el => {
      const scan=getComputedStyle(document.querySelector('#roots-form')).backgroundColor;
      return {scan,header:getComputedStyle(el.querySelector('.source-tools')).backgroundColor,footer:getComputedStyle(el.querySelector('.source-foot')).backgroundColor};
    });
    assert.equal(chrome.header,chrome.scan,`${theme}: admin toolbar uses the shared card fill`);
    assert.equal(chrome.footer,chrome.scan,`${theme}: admin path bar uses the shared card fill`);
    const zebra=await active.locator('.library-column[data-root=local][data-directory=""] .library-folder:not(.library-column-path)').evaluateAll(rows => {
      const fill=el => {const style=getComputedStyle(el);return {color:style.backgroundColor,image:style.backgroundImage};};
      return rows.slice(0,2).map(row => ({row:fill(row),icon:fill(row.querySelector('.source-thumb'))}));
    });
    assert.equal(zebra.length,2);
    assert.notDeepEqual(zebra[0].row,zebra[1].row,`${theme}: adjacent rows retain distinct fills`);
    assert.deepEqual(zebra[0].row,zebra[1].icon,`${theme}: the first row is exactly the second icon background`);
    assert.deepEqual(zebra[1].row,zebra[0].icon,`${theme}: the second row is exactly the first icon background`);
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
  const overlay=await embedded.evaluate(el => {
    const rail=el.querySelector('.library-horizontal-scrollbar'), column=el.querySelector('.library-column'), footer=el.querySelector('.source-foot');
    const list=el.querySelector('#source-list'), previous=list.style.paddingBottom;
    list.style.paddingBottom='calc(var(--foot-h) + 14px)';
    const legacyGap=footer.getBoundingClientRect().top-column.getBoundingClientRect().bottom;
    list.style.paddingBottom=previous;
    return {bottom:column.getBoundingClientRect().bottom,footer:footer.getBoundingClientRect().top,height:rail.getBoundingClientRect().height,
      position:getComputedStyle(rail).position,fill:getComputedStyle(rail).backgroundColor,legacyGap};
  });
  assert.ok(Math.abs(overlay.legacyGap-14)<1,'injecting the old reserved strip reproduces the missing content height');
  assert.ok(Math.abs(overlay.bottom-overlay.footer)<1,'columns extend to the footer without a reserved scrollbar strip');
  assert.equal(overlay.height,6);assert.equal(overlay.position,'absolute');assert.equal(overlay.fill,'rgba(0, 0, 0, 0)');
  await horizontalRail.scrollIntoViewIfNeeded();
  const thumbBox=await horizontalRail.locator('span').boundingBox();
  await managed.mouse.move(thumbBox.x+thumbBox.width/2,thumbBox.y+thumbBox.height/2); await managed.mouse.down();
  await managed.mouse.move(thumbBox.x+thumbBox.width/2+70,thumbBox.y+thumbBox.height/2); await managed.mouse.up();
  assert.ok(await embedded.locator('#source-list').evaluate(el => el.scrollLeft>50),'the bottom scrollbar can be dragged');
  await horizontalRail.focus(); await managed.keyboard.press('Home');
  assert.equal(await embedded.locator('#source-list').evaluate(el => el.scrollLeft),0);
  await managed.locator('#library-location').focus();await managed.mouse.move(0,0);
  await managed.waitForFunction(() => !document.querySelector('.library-horizontal-scrollbar').classList.contains('is-active'));
  await managed.setViewportSize({width:320,height:820});
  await managed.waitForFunction(() => document.querySelector('.library-column').getBoundingClientRect().width<=document.querySelector('#source-list').clientWidth);
  await managed.setViewportSize({width:1200,height:820});
  await managed.waitForFunction(() => Math.round(document.querySelector('.library-column').getBoundingClientRect().width)===320);
  assert.deepEqual(await widths(),[320,280,296,280],'responsive clamping never overwrites the desired width');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-admin-columns-deep-${browserName}.png`});
  await active.locator('.library-column[data-root=local][data-directory=""] .library-column-path').click();
  await active.locator('.library-column[data-directory="z-branch"] .library-folder').click();
  await active.locator('.library-column[data-directory="z-branch/leaf"] .source-file').waitFor();
  await chooseView('list');
  assert.equal(await embedded.locator('#library-location').inputValue(),'leaf');
  assert.equal(await active.locator('.source-file .filename').innerText(),'nested.mp4');
  const compactButton=embedded.locator('#library-compact');
  assert.equal(await compactButton.getAttribute('data-compact'),'false');
  await managed.evaluate(() => {window.compactRow=document.querySelector('#source-list .library-list-view .source-file');});
  await compactButton.click();
  await player.waitForFunction(() => document.querySelector('#library-compact')?.getAttribute('data-compact')==='true');
  const playerCompact=await player.locator('#source-list .library-mount[data-root-id=local]').evaluate(row => ({height:row.getBoundingClientRect().height,
    metadata:getComputedStyle(row.querySelector('.source-meta')).display,thumb:row.querySelector('.source-thumb').getBoundingClientRect().width}));
  assert.deepEqual(playerCompact,{height:28,metadata:'none',thumb:20},'player and admin share compact styling and preferences');
  const compactState=await active.locator('.source-file').evaluate(row => ({height:row.getBoundingClientRect().height,
    metadata:getComputedStyle(row.querySelector('.source-meta')).display,same:row===window.compactRow}));
  assert.ok(compactState.height<=28,'compact rows use a single short line');
  assert.equal(compactState.metadata,'none');assert.equal(compactState.same,true,'density changes retain the existing row and decoded thumbnail');
  await embedded.locator('#library-location').focus(); await embedded.locator('#library-location').fill('nested');
  await managed.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy')==='false');
  await chooseView('columns');
  await active.locator('.library-column').last().locator('.source-file').waitFor();
  assert.equal(await compactButton.getAttribute('data-compact'),'true','compact density is independent of list/column mode');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-admin-compact-${browserName}.png`});
  await compactButton.click();
  assert.equal(await embedded.locator('#library-location').inputValue(),'nested','view changes retain the directory search');
  await player.waitForFunction(() => document.querySelector('#library-compact')?.getAttribute('data-compact')==='false');
  await player.locator('#library-compact').click();
  await managed.waitForFunction(() => document.querySelector('#library-compact')?.getAttribute('data-compact')==='true');
  await player.locator('#library-compact').click();
  await managed.waitForFunction(() => document.querySelector('#library-compact')?.getAttribute('data-compact')==='false');
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
    await pressedFile.evaluate(async el=>{
      await Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{})));
      await new Promise(requestAnimationFrame);
    });
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
      assert.ok(samples.some(sample => sample.fill === (phase==='press'?heldFill:hoverFill)),`${theme}: ${phase} reaches its visible feedback state`);
      assert.ok(samples.every(sample => sample.inner==='rgba(0, 0, 0, 0)'),`${theme}: ${phase} never adds a second inner highlight`);
    }
  }
  const selectionFolder=active.locator('.library-folder').filter({hasText:'folder-000'});
  const sampleSelection = async select => {
    const samples = await selectionFolder.evaluate(async (el,select) => {
      const box=el.querySelector('.source-thumb');
      await Promise.all([...el.getAnimations(),...box.getAnimations()].map(animation=>animation.finished.catch(()=>{})));
      const sample=()=>{
        const row=getComputedStyle(el),thumb=getComputedStyle(box);
        return {text:row.color,icon:thumb.color,layers:thumb.backgroundImage,fill:row.backgroundColor,thumbFill:thumb.backgroundColor};
      };
      const samples=[sample()];
      (select?el:el.closest('[data-library-view-surface]').querySelector('.source-file')).click();
      await Promise.all([...el.getAnimations(),...box.getAnimations()].map(animation=>animation.finished.catch(()=>{})));
      await new Promise(requestAnimationFrame);
      samples.push(sample());
      return samples;
    },select);
    if(select)await managed.waitForFunction(()=>document.querySelector('#library-location').value==='folder-000');
    return samples;
  };
  for (const theme of ['dark','light']) {
    await player.evaluate(theme => localStorage.setItem('voidplayer.theme',theme),theme);
    await managed.waitForFunction(theme => document.documentElement.dataset.theme===theme,theme);
    await managed.waitForTimeout(320);
    const select=await sampleSelection(true);
    const deselect=await sampleSelection(false);
    for (const [phase,samples] of [['select',select],['deselect',deselect]]) {
      const final=samples.at(-1);
      assert.notEqual(samples[0].text,final.text,`${theme}: ${phase} updates the row text`);
      assert.notEqual(samples[0].icon,final.icon,`${theme}: ${phase} updates the icon`);
      assert.notEqual(samples[0].fill,final.fill,`${theme}: ${phase} updates the row fill`);
      assert.notEqual(samples[0].thumbFill,final.thumbFill,`${theme}: ${phase} updates the thumbnail fill`);
      assert.equal(new Set(samples.map(sample => sample.layers)).size,1,`${theme}: ${phase} preserves the zebra backing layer`);
    }
    await goLibrary('library:local');
  }
  await managed.emulateMedia({reducedMotion:'reduce'});
  const rootColumn=() => active.locator('.library-column[data-root=local][data-directory=""]');
  const folderRow=name => rootColumn().locator(`.library-folder[data-library-path="${name}"]`);
  await folderRow('folder-000').click();
  await managed.waitForFunction(() => document.querySelector('#library-location').value==='folder-000');
  await folderRow('folder-002').click({modifiers:['Shift']});
  assert.equal(await active.locator('.library-item-selected').count(),3,'Shift selects a contiguous range within one column');
  assert.equal(await embedded.locator('#library-location').inputValue(),'folder-000','multi-selection does not navigate away from its column');
  await folderRow('folder-004').click({modifiers:['Meta']});
  assert.equal(await active.locator('.library-item-selected').count(),4,'Command adds an individual item');
  await folderRow('folder-001').evaluate(el => el.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})));
  assert.equal(await active.locator('.library-item-selected').count(),3,'Windows Control toggles an individual item');
  assert.equal(await managed.evaluate(() => getSelection()?.toString()),'','range selection never selects page text');
  // Selecting an item in another column clears the previous column's selection.
  await goLibrary('library:local/z-branch/leaf');
  await active.locator('.library-column').last().locator('.source-file').click();
  assert.equal(await active.locator('.library-item-selected').count(),1);
  assert.equal(await active.locator('.library-item-selected .filename').innerText(),'nested.mp4');
  assert.equal(await active.locator('.library-column-path.library-item-selected').count(),0,'ancestor path markers remain neutral');
  await managed.locator('.admin-library-card').screenshot({path:`/tmp/voidplayer-library-selection-${browserName}.png`});
  await goLibrary('library:local');
  await active.locator('.source-file').click();
  for (const name of ['folder-000','folder-002','folder-004','folder-006']) await folderRow(name).click({modifiers:['Meta']});
  assert.equal(await active.locator('.library-item-selected').count(),5);
  let moveRequests=0;
  managed.on('request',request => {if(new URL(request.url()).pathname==='/api/library/files'&&request.method()==='POST')moveRequests++;});
  const startFileDrag=async () => {
    const source=rootColumn().locator('.source-file');await source.scrollIntoViewIfNeeded();
    const box=await source.boundingBox();
    await managed.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await managed.mouse.down();
    await managed.mouse.move(box.x+box.width*.5+12,box.y+box.height*.5,{steps:3});
    await managed.locator('.library-drag-preview').waitFor();
  };
  await startFileDrag();
  assert.equal(await managed.locator('.library-drag-item').count(),5,'drag preview is a compact list of the actual selected items');
  assert.equal(await managed.locator('.library-drag-count').innerText(),'5');
  await managed.mouse.move(20,20);
  assert.equal(await managed.locator('.library-drag-preview').getAttribute('data-allowed'),'false');
  await managed.keyboard.press('Escape');await managed.mouse.up();
  assert.equal(moveRequests,0,'cancelling a drag never mutates files');
  assert.equal(await active.locator('.library-item-selected').count(),5,'drag cancellation preserves the selection');
  const dropOn=async row => {
    await row.scrollIntoViewIfNeeded();const box=await row.boundingBox();
    await managed.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:5});
    await managed.waitForFunction(() => document.querySelector('.library-drag-preview')?.dataset.allowed==='true');
    const response=managed.waitForResponse(response => new URL(response.url()).pathname==='/api/library/files'&&response.request().method()==='POST');
    await managed.mouse.up();const result=await (await response).json();
    assert.ok(result.results.every(item => item.ok),JSON.stringify(result));
    await managed.waitForFunction(() => document.querySelector('#admin-library-browser').getAttribute('aria-busy')!=='true');
  };
  await startFileDrag();
  await folderRow('folder-010').scrollIntoViewIfNeeded();
  const dragTarget=await folderRow('folder-010').boundingBox();
  await managed.mouse.move(dragTarget.x+dragTarget.width*.5,dragTarget.y+dragTarget.height*.5,{steps:5});
  await managed.locator('.library-drag-preview').screenshot({path:`/tmp/voidplayer-library-move-preview-${browserName}.png`});
  await dropOn(folderRow('folder-010'));
  assert.equal(moveRequests,1);
  await assert.rejects(readFile(path.join(media,'sample.mp4')),{code:'ENOENT'});
  assert.equal((await readFile(path.join(media,'folder-010/sample.mp4'))).length,4*1024*1024);
  await goLibrary('library:local/folder-010');
  const movedColumn=active.locator('.library-column').last();
  await movedColumn.locator('.source-file').click();await managed.keyboard.press('ControlOrMeta+a');
  assert.equal(await active.locator('.library-item-selected').count(),5,'select-all stays within the focused column');
  const movedBox=await movedColumn.locator('.source-file').boundingBox();
  await managed.mouse.move(movedBox.x+movedBox.width*.5,movedBox.y+movedBox.height*.5);await managed.mouse.down();
  await managed.mouse.move(movedBox.x+movedBox.width*.5+12,movedBox.y+movedBox.height*.5,{steps:3});
  await managed.locator('.library-drag-preview').waitFor();
  await dropOn(active.locator('.library-mount[data-root-id=local]'));
  assert.equal(moveRequests,2,'dropping on a mount moves the selection back to its root');
  assert.equal((await readFile(path.join(media,'sample.mp4'))).length,4*1024*1024);
  await goLibrary('library:local');
  await chooseView('list');
  await active.locator('.source-file').click();
  assert.equal(await active.locator('.library-item-selected').count(),1,'list view uses the same selection model');
  const beforeRevision=await active.locator('.source-file').getAttribute('data-library-version');
  await utimes(path.join(media,'sample.mp4'),new Date(),new Date(Date.now()+1000));await service.library.refresh();
  await goLibrary('library:local');
  assert.notEqual(await active.locator('.source-file').getAttribute('data-library-version'),beforeRevision);
  assert.equal(await active.locator('.library-item-selected').count(),1,'a metadata refresh preserves path selection without reusing its old media version');
  await chooseView('columns');
  assert.equal(await active.locator('.library-item-selected').count(),0,'changing view does not retain a selection in a hidden column');
  await goLibrary('library:local/z-branch/leaf');
  const covered=service.library.browse({rootId:'local',directory:'z-branch/leaf'}).entries[0];
  service.library.thumbnails.put(covered.id,covered.version,THUMB_RECIPE_VERSION,service.library.thumbnails.epoch,Buffer.from(cover,'base64'),{width:40,height:24,sourcePtsUs:0});
  await goLibrary('library:local/z-branch/leaf');
  const nestedFile=active.locator('.source-file').filter({hasText:'nested.mp4'});
  await nestedFile.waitFor();
  const coveredColumn=active.locator('.library-column[data-directory="z-branch/leaf"]');
  await coveredColumn.locator('[data-library-path="z-branch/leaf/target"]').click();
  await active.locator('.library-column[data-directory="z-branch/leaf/target"]').waitFor();
  await nestedFile.click();
  const thumbnail=nestedFile.locator('.source-thumb img');
  await managed.waitForFunction(() => {
    const img=document.querySelector('.source-file[data-library-path="z-branch/leaf/nested.mp4"] .source-thumb img');
    return img?.naturalWidth>0&&img.dataset.thumbDecoded==='true';
  });
  await thumbnail.scrollIntoViewIfNeeded();
  const imageBox=await thumbnail.boundingBox();
  const targetFolder=coveredColumn.locator('[data-library-path="z-branch/leaf/target"]');
  const targetBox=await targetFolder.boundingBox();
  await managed.mouse.move(imageBox.x+imageBox.width/2,imageBox.y+imageBox.height/2);await managed.mouse.down();
  await managed.mouse.move(targetBox.x+targetBox.width/2,targetBox.y+targetBox.height/2,{steps:8});
  await managed.locator('.library-drag-preview').waitFor();
  await managed.waitForFunction(() => document.querySelector('.library-drag-preview')?.dataset.allowed==='true');
  await managed.keyboard.press('Escape');await managed.mouse.up();
  assert.equal(moveRequests,2,'a thumbnail drag can be cancelled without changing files');
  // A final release can arrive ahead of the last coalesced move: use its own coordinates.
  await managed.evaluate(() => document.addEventListener('pointerdown',event => {window.coverPointerId=event.pointerId;},{capture:true,once:true}));
  await managed.mouse.move(imageBox.x+imageBox.width/2,imageBox.y+imageBox.height/2);await managed.mouse.down();
  await managed.mouse.move(imageBox.x+imageBox.width/2+12,imageBox.y+imageBox.height/2,{steps:3});
  await managed.locator('.library-drag-preview').waitFor();
  assert.equal(await managed.locator('.library-drag-preview').getAttribute('data-allowed'),'false','the last move is still over the source directory');
  const thumbnailMove=managed.waitForResponse(response => new URL(response.url()).pathname==='/api/library/files'&&response.request().method()==='POST');
  await embedded.dispatchEvent('pointerup',{pointerId:await managed.evaluate(() => window.coverPointerId),pointerType:'mouse',button:0,
    clientX:targetBox.x+targetBox.width/2,clientY:targetBox.y+targetBox.height/2,bubbles:true});
  await managed.mouse.up();const movedFromThumbnail=await (await thumbnailMove).json();
  assert.equal(movedFromThumbnail.results[0].ok,true,JSON.stringify(movedFromThumbnail));
  assert.deepEqual(await readFile(path.join(media,'z-branch/leaf/target/nested.mp4')),await readFile(path.join(root,'fixtures/video/ci_h264_smoke.mp4')));
  // Restore through the same public command so the existing file-link checks remain independent.
  const movedEntry=service.library.browse({rootId:'local',directory:'z-branch/leaf/target'}).entries[0];
  assert.equal(movedEntry.state,'ready','a completed move does not return to the writing/settling state');
  assert.equal(movedEntry.thumbnail,true,'the moved file retains its already-generated cover');
  const movedImage=service.library.thumbnails.get(movedEntry.id,movedEntry.version,THUMB_RECIPE_VERSION);
  assert.deepEqual(Buffer.from(movedImage.data),Buffer.from(cover,'base64'),'moving preserves the exact JPEG, without decoding the video again');
  const restored=await managed.evaluate(async source => {
    const response=await fetch('/api/library/files',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'library-files'},body:JSON.stringify({operation:'move',sources:[source],target:{rootId:'local',directory:'z-branch/leaf'}})});
    return response.json();
  },{rootId:'local',path:movedEntry.name,version:movedEntry.version,kind:'file'});
  assert.equal(restored.results[0].ok,true);
  const returnedEntry=service.library.browse({rootId:'local',directory:'z-branch/leaf'}).entries[0];
  assert.equal(returnedEntry.state,'ready','moving back to a previously indexed path is immediately ready');
  assert.equal(returnedEntry.thumbnail,true,'moving back retains the cover at the new stat version');
  await goLibrary('library:local/z-branch/leaf');
  await rootColumn().locator('.source-file').click();
  await startFileDrag();
  const divider=active.locator('.library-column-splitter').nth(2);
  await divider.scrollIntoViewIfNeeded();
  const dividerBox=await divider.boundingBox();
  const center=dividerBox.x+dividerBox.width/2,y=dividerBox.y+dividerBox.height/2;
  await managed.mouse.move(center+20,y,{steps:3});
  await managed.waitForFunction(() => document.querySelector('.library-drag-preview')?.dataset.allowed==='true');
  assert.equal(await embedded.locator('.library-drop-target').getAttribute('data-directory'),'z-branch/leaf','a real directory blank area still highlights only its own column');
  for (const offset of [-3,0,3]) {
    const x=center+offset;
    assert.equal(await managed.evaluate(({x,y}) => !!document.elementFromPoint(x,y)?.closest('.library-column-splitter'),{x,y}),true,'exercise the splitter hit area, including both sides of its visible line');
    await managed.mouse.move(x,y,{steps:3});
    await managed.waitForFunction(() => document.querySelector('.library-drag-preview')?.dataset.allowed==='false');
    assert.equal(await embedded.locator('.library-drop-target').count(),0,'splitter hit areas never highlight the entire browser or an adjacent directory');
  }
  await managed.mouse.up();
  assert.equal(moveRequests,4,'releasing over a splitter cannot move files');
  assert.equal(await managed.locator('.library-drag-preview').count(),0);
  await managed.waitForFunction(() => document.querySelector('.source-file[data-library-path="z-branch/leaf/nested.mp4"]')?.getAttribute('aria-disabled')==='false');
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
  await chooseView('list'); await compactButton.click(); await managed.reload();
  await managed.waitForFunction(() => document.querySelector('#admin-library-browser')?.dataset.libraryView==='list');
  await active.locator('.library-mount[data-root-id=local]').waitFor();
  assert.equal(await compactButton.getAttribute('data-compact'),'true','density survives reload');
  await compactButton.click();
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
  const direct = await context.newPage();
  // Hold periodic work so each observation comes from selecting the overview.
  await direct.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, delay, ...args) => interval(fn, Math.max(delay ?? 0, 60_000), ...args);
  });
  await direct.goto(base + '/admin#preferences'); await direct.waitForLoadState('networkidle');
  for (let visit = 1; visit <= 2; visit++) {
    await direct.locator('[data-pane=overview]').click();
    await direct.waitForFunction(expected => document.querySelector('#cpu-trend')?.getAttribute('d')?.split('M').length === expected + 1, visit, { timeout: 5000 });
    assert.notEqual(await direct.locator('#uptime').textContent(), '—');
    assert.deepEqual(await direct.locator('.overview-trend path').evaluateAll(paths => paths.map(path => path.getTotalLength())), [0, 0],
      'an isolated observation must show its metric without drawing a dot or bridging a gap');
    if (visit === 2) {
      await direct.locator('[data-pane=overview]').click();
      await direct.waitForFunction(() => [...document.querySelectorAll('.overview-trend path')].every(path => path.getTotalLength() > 0));
    }
    await direct.locator('[data-pane=preferences]').click();
  }
  await direct.getByRole('link', { name: '返回播放器', exact: true }).click(); await direct.waitForURL(base + '/');
  assert.equal(context.pages().length, 2, 'direct admin visits return within their current tab'); await direct.close();
  const otherPlayer = await context.newPage(); await otherPlayer.goto(base);
  const [orphan] = await Promise.all([context.waitForEvent('page'), otherPlayer.locator('#server-status').click()]);
  await orphan.waitForURL(base + '/admin'); await otherPlayer.close();
  await orphan.getByRole('link', { name: '返回播放器', exact: true }).click(); await orphan.waitForURL(base + '/'); await orphan.close();
  [page] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); observeErrors(page, 'admin-second');
  await page.locator('#identity').filter({ hasText: '访客' }).waitFor();

  const navigationWidth = await page.locator('.admin-navigation').evaluate(nav => nav.getBoundingClientRect().width);
  assert.equal(await page.locator('.admin-brand .icon, .admin-nav-caption').count(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const iconDrift = await page.locator('#admin-navigation-toggle').evaluate(async toggle => {
    const nav = toggle.closest('nav'), icons = [...nav.querySelectorAll('[data-pane] .icon, .admin-back .icon')];
    const initial = icons.map(icon => icon.getBoundingClientRect().left);
    let drift = 0;
    toggle.click();
    do {
      for (const [i, icon] of icons.entries()) drift = Math.max(drift, Math.abs(icon.getBoundingClientRect().left - initial[i]));
      await new Promise(requestAnimationFrame);
    } while (nav.parentElement.getAnimations().some(animation => animation.playState === 'running'));
    return drift;
  });
  assert.ok(iconDrift <= 0.5, `navigation icons moved ${iconDrift}px while collapsing`);
  await page.waitForFunction(() => document.querySelector('.admin-navigation').getBoundingClientRect().width === 56);
  assert.equal(await page.locator('#admin-navigation-toggle').getAttribute('aria-expanded'), 'false');
  const iconOffsets = await page.locator('.admin-navigation').evaluate(nav => {
    const center = el => { const rect = el.getBoundingClientRect(); return rect.left + rect.width / 2; };
    return [...nav.querySelectorAll('.icon')].map(icon => center(icon) - center(nav));
  });
  assert.ok(iconOffsets.every(offset => Math.abs(offset) <= 0.5), `collapsed navigation icon offsets: ${iconOffsets}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', {name:'首选项', exact:true}).click();
  assert.equal(await page.locator('#pane-preferences #analysis-resources').isVisible(), true);
  assert.equal(await page.locator('#pane-overview #analysis-resources').count(), 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.admin-navigation').getBoundingClientRect().width === 56);
  assert.equal(await page.locator('#analysis-resources').isVisible(), true, 'navigation and the preferences pane survive reload');
  await page.locator('#admin-navigation-toggle').click();
  assert.equal(await page.locator('.admin-navigation').evaluate(nav => nav.getBoundingClientRect().width), navigationWidth);

  await page.waitForFunction(() => document.getElementById('analysis-concurrency')?.value === '8');
  await page.locator('[data-pane=preferences]').click();
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
  await page.getByLabel('服务端分析并发数').fill('33');
  assert.equal(await page.locator('#analysis-resource-save').isDisabled(), true);
  await page.locator('#analysis-resource-reload').click();
  await page.waitForFunction(() => document.getElementById('analysis-concurrency')?.value === '12');

  await page.locator('[data-pane=overview]').click();
  assert.equal(await page.evaluate(() => { const rows = [...document.querySelectorAll('#pane-overview .admin-properties > div')]; return rows.every((r, i) => !i || r.getBoundingClientRect().top > rows[i-1].getBoundingClientRect().top); }), true, 'properties must remain a single ordered list');
  await page.screenshot({ path: `/tmp/voidplayer-admin-overview-light-${browserName}.png` });
  const headingBeforeToast=await page.locator('#pane-overview .admin-heading').evaluate(el => el.offsetTop);
  await page.route('**/api/admin/status?view=overview', route => route.fulfill({ status: 503, json: { error: '服务暂不可用，请重试' } }));
  await page.waitForResponse('**/api/admin/status?view=overview');
  await page.locator('.admin-toast-stack .toast-error').filter({ hasText: '服务暂不可用' }).waitFor();
  assert.equal(await page.locator('#admin-message').count(),0,'global notices no longer occupy an in-page message panel');
  assert.equal(await page.locator('.admin-toast-stack').evaluate(el => el.matches(':popover-open')),true,'admin uses the shared top-layer toast');
  assert.equal(await page.locator('#pane-overview .admin-heading').evaluate(el => el.offsetTop),headingBeforeToast,'errors do not shift page content');
  await page.waitForResponse('**/api/admin/status?view=overview');
  assert.equal(await page.locator('.admin-toast-stack .toast-error').count(),1,'repeated polling errors do not accumulate identical toasts');
  await page.screenshot({ path: `/tmp/voidplayer-admin-status-error-${browserName}.png` });
  await page.locator('.admin-toast-stack .toast-close').click();
  await page.locator('.admin-toast-stack .toast').waitFor({state:'hidden'});
  await page.waitForResponse('**/api/admin/status?view=overview');
  await page.locator('.admin-toast-stack .toast-error').waitFor();
  await page.unroute('**/api/admin/status?view=overview');
  await page.waitForResponse('**/api/admin/status?view=overview');
  await page.locator('.admin-toast-stack .toast').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.getByLabel('目录名称').first().waitFor();
  await page.locator('.admin-root-row[data-id=offline] .admin-root-scan[data-state=offline]').waitFor();
  const actualScan=await (await fetch(base+'/api/library/scan')).json();
  let scanView={...actualScan,ready:true,scanning:false,scanMode:null,inventory:{media:37,pending:0},queuedDirectories:0,
    roots:actualScan.roots.map(root => ({...root,state:'ready',scanRequested:false,error:null})),errors:[],
    job:{...actualScan.job,state:'completed',files:1,visited:1,errors:0}};
  const submitted=[];let acknowledge;
  const accepted=new Promise(resolve => {acknowledge=resolve;});
  await page.route('**/api/library/scan*',async route => {
    if (route.request().method()==='POST') {
      submitted.push(route.request().postDataJSON());await accepted;
      await route.fulfill({status:202,json:scanView});
    } else await route.fulfill({json:scanView});
  });
  const showScan=async () => {
    const response=page.waitForResponse(response => new URL(response.url()).pathname==='/api/library/scan' && response.request().method()==='GET');
    await page.locator('[data-pane=library]').click();await response;
  };
  await showScan();
  const rootScan=page.locator('.admin-root-row[data-id=local] .admin-root-scan');
  assert.equal(await page.locator('#scan-progress, #scan-current, #scan-refresh, #scan-cancel, .admin-root-state, .admin-scan-status').count(),0,
    'only per-directory scan controls remain; there are no global scan controls or visible progress/status columns');
  assert.equal(await page.locator('#control-tooltip').count(),1,'admin controls share one tooltip owner');
  assert.equal(await page.locator('.admin-root-row .admin-root-scan').count(),actualScan.roots.length);
  await rootScan.hover();await page.locator('#control-tooltip').filter({hasText:'已扫描'}).waitFor();
  assert.equal(await rootScan.getAttribute('aria-disabled'),'false');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await rootScan.click();
  await page.waitForFunction(()=>document.querySelector('.admin-root-row[data-id=local] .admin-root-scan')?.getAttribute('aria-busy')==='true');
  assert.ok(await rootScan.locator('.icon').evaluate(el => getComputedStyle(el).animationName!=='none'),'the icon animates immediately while awaiting acceptance');
  scanView={...scanView,scanning:true,scanMode:'incremental',
    roots:scanView.roots.map(root => ({...root,state:root.id==='local'?'scanning':'ready',scanRequested:root.id==='local'})),
    job:{...scanView.job,state:'running',current_root:'local',current_path:'z-branch/leaf'}};
  acknowledge();await showScan();
  assert.deepEqual(submitted,[{action:'refresh',rootId:'local'}],'the row dispatches only its committed root');
  await page.mouse.move(20,20);await rootScan.hover();
  await page.locator('#control-tooltip').filter({hasText:'本轮已读取 1 个目录、1 个媒体'}).waitFor();
  assert.match(await page.locator('#control-tooltip').innerText(),/z-branch\/leaf/);
  const busyBox=await rootScan.boundingBox();await page.mouse.click(busyBox.x+busyBox.width/2,busyBox.y+busyBox.height/2);
  assert.equal(submitted.length,1,'busy row clicks cannot submit duplicate scans');
  scanView={...scanView,roots:scanView.roots.map(root => ({...root,state:'ready'})),job:{...scanView.job,current_root:'offline'}};
  await showScan();
  await page.locator('.admin-root-row[data-id=local] .admin-root-scan[data-state=unscanned]').waitFor();
  assert.equal(await rootScan.getAttribute('aria-busy'),'true','a queued root stays busy while a different root is being read');
  assert.match(await rootScan.getAttribute('data-tooltip'),/等待扫描/);
  assert.doesNotMatch(await rootScan.getAttribute('data-tooltip'),/本轮已读取/,'unrelated-root progress is not attributed to this row');
  scanView={...scanView,scanning:false,scanMode:null,roots:scanView.roots.map(root => ({...root,scanRequested:false})),
    job:{...scanView.job,state:'completed',current_root:null,current_path:null}};
  await showScan();await page.locator('.admin-root-row[data-id=local] .admin-root-scan[aria-busy=false]').waitFor();
  assert.equal(await rootScan.locator('.icon').evaluate(el => getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'reduce'});
  for (const [state,label] of [['cancelled','已停止'],['partial','部分路径不可读'],['error','扫描出错']]) {
    scanView={...scanView,roots:scanView.roots.map(root => root.id==='local'?{...root,state}:root)};await showScan();
    await page.locator(`.admin-root-row[data-id=local] .admin-root-scan[data-state=${state}]`).waitFor();
    assert.ok((await rootScan.getAttribute('data-tooltip')).includes(label));
  }
  scanView={...scanView,roots:actualScan.roots,job:{...scanView.job,state:'completed',errors:1},
    errors:[{root_id:'local',path:'unreadable',code:'EACCES'}]};await showScan();
  assert.equal(await page.locator('#scan-issues').evaluate(el => el.closest('form')?.id),'roots-form');
  await page.locator('#scan-errors').filter({hasText:'无法读取此目录'}).waitFor();
  await page.unroute('**/api/library/scan*');await showScan();
  await page.locator('.admin-root-row[data-id=offline] .admin-root-scan[data-state=offline]').waitFor();
  const aligned = await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => {
    const inputs=row.querySelectorAll('input');return Math.abs(inputs[0].getBoundingClientRect().top-inputs[1].getBoundingClientRect().top)<1;
  }));
  assert.equal(aligned,true,'name and path inputs remain aligned');
  assert.equal(await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => {
    const path=row.querySelector('[data-field=path]').getBoundingClientRect(), scan=row.querySelector('.admin-root-scan').getBoundingClientRect();
    return path.right<=scan.left && scan.width===32 && scan.right<=row.querySelector('.admin-danger').getBoundingClientRect().left;
  })),true,'the scan action is a single icon immediately before remove');
  const rootsCard=await page.locator('#roots-form').evaluate(form => {
    const editor=form.querySelector('#root-editor').getBoundingClientRect();
    return {controls:['reset-roots','save-roots'].map(id => form.querySelector('#'+id).getBoundingClientRect().bottom<=editor.top),
      borders:[...form.querySelectorAll('input')].map(input => getComputedStyle(input).borderWidth),
      saveGlyph:form.querySelector('#save-roots .icon')?.getAttribute('data-icon'),saveText:form.querySelector('#save-roots').textContent.trim()};
  });
  assert.ok(rootsCard.controls.every(Boolean),'save and reset actions sit above the directory editor');
  assert.ok(rootsCard.borders.every(border => border==='0px'),'directory fields use borderless setting-style fills');
  assert.deepEqual(await page.locator('.admin-root-columns > span').allTextContents(),['名称','服务器路径'],'the directory editor has one shared header');
  assert.equal(await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => getComputedStyle(row).borderTopWidth==='0px'
    && [...row.querySelectorAll('label')].every(label => !label.textContent.trim()))),true,'directory rows have no separators or repeated headings');
  assert.equal(rootsCard.saveGlyph,'save');assert.equal(rootsCard.saveText,'','the save action is an accessible floppy-disk icon');
  await page.getByLabel('目录名称').first().fill('本机拍摄素材');
  const leavePrompt = page.waitForEvent('dialog');
  const returnClick = page.getByRole('link', { name: '返回播放器', exact: true }).click();
  await (await leavePrompt).dismiss(); await returnClick;
  assert.equal(page.isClosed(), false, 'canceling return preserves unsaved directory edits');
  assert.equal(await page.getByLabel('目录名称').first().inputValue(), '本机拍摄素材');

  // Polling is intentionally observed while editing: it must preserve the input node.
  const scanWhileEditing = page.waitForResponse('**/api/library/scan?offset=*');
  await page.locator('[data-pane=library]').click();
  await scanWhileEditing;
  await page.waitForFunction(() => document.querySelector('[data-field=name]')?.value === '本机拍摄素材');
  await page.getByRole('button', { name: '添加目录', exact: true }).click();
  assert.equal(await page.locator('#add-root').isDisabled(),true,'only one unsaved new library can be edited');
  await page.locator('#add-root').evaluate(button => { for(let i=0;i<4;i++)button.dispatchEvent(new MouseEvent('click')); });
  assert.equal(await page.locator('.admin-root-row').count(),3,'repeated activation cannot create extra draft rows');
  const previousViewport = page.viewportSize();
  await page.setViewportSize({width:350, height:786});
  const rowsFit = await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => {
    const box = selector => row.querySelector(selector).getBoundingClientRect();
    const name = box('[data-field=name]'), path = box('[data-field=path]'), scan = box('.admin-root-scan'), remove = box('.admin-danger');
    return name.right <= scan.left && scan.right <= remove.left && Math.abs(name.top + name.height / 2 - scan.top - scan.height / 2) < 1
      && remove.top === scan.top && path.top >= name.bottom && Math.abs(path.right - remove.right) < 1;
  }));
  assert.ok(rowsFit, 'saved and draft directory actions stay beside the name, above the full-width path');
  await page.setViewportSize(previousViewport);
  await page.locator('.admin-root-row').last().locator('.admin-danger').click();
  assert.equal(await page.locator('#add-root').isEnabled(),true,'discarding the draft permits another library');
  await page.locator('#add-root').click();
  assert.equal(await page.locator('.admin-root-row').last().locator('.admin-root-scan').getAttribute('aria-disabled'),'true');
  assert.match(await page.locator('.admin-root-row').last().locator('.admin-root-scan').getAttribute('data-tooltip'),/待保存/);
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-editing-${browserName}.png` });
  await page.getByLabel('目录名称').last().fill('制作素材'); await page.getByLabel('服务器上的目录路径').last().fill(extra);
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-roots').disabled && document.getElementById('roots-form').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#add-root').isEnabled(),true,'saving the draft permits another library');
  const stored = JSON.parse(await readFile(file, 'utf8')); assert.equal(stored.mediaRoots.length, 3); assert.equal(stored.mediaRoots[0].id, 'local'); assert.equal(stored.mediaRoots[0].name, '本机拍摄素材');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-light-${browserName}.png` });
  // Cross-tab theme synchronization uses the existing shared browser preference.
  await player.evaluate(() => localStorage.setItem('voidplayer.theme', 'dark'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-dark-${browserName}.png` });
  await page.locator('#roots-form').screenshot({path:`/tmp/voidplayer-admin-roots-card-${browserName}.png`});
  await page.getByRole('button', { name: '日志', exact: true }).click();
  assert.ok(await page.locator('.admin-log-retention').evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.admin-log-tabs').getBoundingClientRect().top));
  await page.locator('#log-storage h3').filter({ hasText: '上传报告' }).waitFor();
  await page.locator('#log-storage').filter({ hasText: '保留到手动删除' }).waitFor();
  assert.ok((await page.locator('#log-storage').textContent()).includes('运行日志'));
  const logStorage = await page.request.get(base + '/api/admin/logs').then(response => response.json());
  assert.equal(await page.getByRole('progressbar', {name:'报告数量', exact:true}).getAttribute('max'), String(logStorage.storage.reports.maxFiles));
  assert.equal(await page.getByRole('progressbar', {name:'报告数量', exact:true}).getAttribute('value'), String(logStorage.storage.reports.files));
  assert.equal(await page.getByRole('progressbar', {name:'存储占用', exact:true}).count(), 2);
  assert.equal(await page.locator('.admin-log-item').first().evaluate(row => getComputedStyle(row).padding), '4px');
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
  assert.equal(await page.locator('.admin-measure-metrics > div').first().evaluate(tile => getComputedStyle(tile).background),
    await page.locator('#pane-overview .admin-metrics > div').first().evaluate(tile => getComputedStyle(tile).background),
    'overview and measurements share the same neutral metric surface');
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
    for (const name of ['概览', '媒体库', '缓存', '标注', '日志', '测速', '首选项']) {
      await page.getByRole('button', { name, exact: true }).click();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.admin-content > section:not([hidden])')].every(e => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(fits, true, `${name} overflows at ${width}px`);
      if (width === 390) {
        const visible = await page.locator('#admin-navigation-items').evaluate(strip => {
          const buttons = [...strip.querySelectorAll('button')], active = strip.querySelector('[aria-current=page]');
          const box = strip.getBoundingClientRect(), selected = active.getBoundingClientRect();
          return buttons.every(button => Math.abs(button.getBoundingClientRect().top - selected.top) < 1)
            && selected.left >= box.left - 1 && selected.right <= box.right + 1 && getComputedStyle(active, '::after').height === '2px';
        });
        assert.ok(visible, `${name} stays visible in a single row of categories`);
      }
      await page.screenshot({ path: `/tmp/voidplayer-admin-${name}-${width}-${browserName}.png` });
    }
  }
  assert.equal(await page.locator('[data-pane=quality], [data-pane=tasks], [data-pane=discovery]').count(), 0);
  for (const pane of ['quality', 'tasks', 'discovery']) {
    await page.goto(base + '/admin#' + pane);
    await page.reload();
    await page.locator('#pane-overview:visible').waitFor();
  }
  await page.setViewportSize({ width: 390, height: 820 });
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
  await page.locator('[data-pane=logs]').click();
  let deliverRequests, requestStarted;
  const held = new Promise(resolve => { deliverRequests = resolve; });
  const started = new Promise(resolve => { requestStarted = resolve; });
  const delayFirstHistory = async route => { requestStarted(); await held; await route.continue(); };
  await page.route('**/api/admin/requests?*', delayFirstHistory);
  await page.locator('[data-log-mode=requests]').click(); await started;
  assert.ok(await page.locator('#uploads-view').isVisible(), 'keep reports on screen until the first history snapshot arrives');
  await page.locator('[data-log-mode=uploads]').click();
  deliverRequests(); await page.waitForLoadState('networkidle');
  assert.ok(await page.locator('#uploads-view').isVisible(), 'a late response cannot switch away from reports');
  await page.unroute('**/api/admin/requests?*', delayFirstHistory);
  await page.locator('[data-log-mode=requests]').click();
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(6500);
  assert.ok(requestReads.some(read => read.status === 304 && read.conditional), 'unchanged request history sends a validator and reuses the current actor snapshot');
  assert.ok(await page.locator('#request-list .admin-request-row').count() > 0, 'the revalidated snapshot stays rendered');
  await page.locator('#request-list .admin-request-row > span:first-child').filter({ hasText: '127.0.0.1' }).first().waitFor();
  assert.equal(overviewReads.length, 0, 'request history does not poll the hidden overview');
  await page.locator('[data-pane=annotations]').click(); await page.waitForLoadState('networkidle');
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
