import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, utimes, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';
const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-library-ui-'));
const media = path.join(directory, 'archive'), clips = path.join(media, '实验一');
await mkdir(path.join(clips, 'nested'), { recursive: true });
for (let i = 0; i < 65; i++) await mkdir(path.join(clips, `folder-${i}`));
for (let i = 0; i < 70; i++) await writeFile(path.join(clips, `clip-${String(i).padStart(3, '0')}.mp4`), 'browse fixture');
await writeFile(path.join(clips, 'nested/deep-clip.mp4'), 'deep fixture');
await copyFile('fixtures/video/ci_h264_smoke.mp4', path.join(clips, 'clip-069.mp4'));
const sample = path.join(media, 'sample.mp4'); await copyFile('fixtures/video/ci_h264_smoke.mp4', sample); await utimes(sample, 1000, 1000);
let libraryNow = Date.now();
const library = new MediaLibraryIndex([{ id: 'archive', path: media, name: '项目归档' }], { watch: false, now: () => libraryNow, scanDelayMs: 10 });
await library.refresh(); library.start();
const server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const engine = process.argv.find(arg => arg === 'webkit' || arg === 'chromium') ?? 'webkit'; const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
try {
  const context = await browser.newContext({locale:'zh-CN', viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage(); const errors = [], legacy = [], protocolSearches = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/library/browse' && /^(library:|https?:)/i.test(url.searchParams.get('search') ?? '')) protocolSearches.push(url.href);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/library') legacy.push(request.url()); });
  const go = async path => {
    await page.locator('#library-location').fill(path); await page.locator('#library-location').press('Enter');
    await page.waitForFunction(() => document.querySelector('#source-list')?.getAttribute('aria-busy') === 'false');
  };
  const search = async value => { await page.locator('#library-location').focus(); await page.locator('#library-location').fill(value); };
  const clearSearch = () => page.locator('#library-location').press('Escape');
  await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
  await page.locator('#toggle-sources').click();
  await page.getByRole('button', {name:'打开媒体库：项目归档', exact:true}).waitFor();
  assert.match(await page.locator('#library-mounts .source-meta').innerText(), /可用 \/ 共/);
  assert.equal(await page.locator('#source-tools').evaluate(el => getComputedStyle(el).gap), '4px');
  assert.equal(await page.locator('#sources-search-toggle, #source-search, #source-search-field, #library-root, #library-root-menu').count(), 0);
  assert.equal(await page.locator('#library-location').inputValue(), '媒体库');
  assert.equal(await page.locator('.crumbs-back').isDisabled(), true);
  assert.equal(await page.locator('.crumbs-forward').isDisabled(), true);
  assert.deepEqual(await page.locator('.source-group-label').allTextContents(), ['库列表', '最近打开']);
  await page.evaluate(() => {
    window.copiedMountPaths=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      write:async items => {window.copiedMountPaths.push(await (await items[0].getType('text/plain')).text());},
      writeText:async text => {window.copiedMountPaths.push(text);},
    }});
  });
  const mountRow = page.getByRole('button',{name:'打开媒体库：项目归档',exact:true});
  await mountRow.click({button:'right'});
  assert.deepEqual(await page.locator('#library-file-menu button').allTextContents(), ['拷贝挂载路径']);
  await page.locator('#library-file-menu [data-action=copy-mount-path]').click();
  await page.waitForFunction(() => window.copiedMountPaths.length === 1);
  assert.deepEqual(await page.evaluate(() => window.copiedMountPaths), [path.resolve(media)]);
  assert.equal(await page.locator('#library-location').inputValue(), '媒体库', 'copying a mount path does not navigate');
  const contact={pointerId:53,pointerType:'touch',isPrimary:true,button:0,clientX:1100,clientY:110};
  await mountRow.dispatchEvent('pointerdown',contact); await page.waitForTimeout(550);
  assert.equal(await page.locator('#library-file-menu').evaluate(el => el.matches(':popover-open')),true,'mount rows support long press');
  await mountRow.dispatchEvent('pointerup',contact);
  await mountRow.evaluate(el => el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})));
  assert.equal(await page.locator('#library-location').inputValue(), '媒体库', 'releasing a long press does not open the mount');
  await page.keyboard.press('Escape');
  assert.equal((await fetch(`${base}/api/library/roots/unknown/location`)).status,404);
  assert.equal((await fetch(`${base}/api/library/roots/archive/location`,{method:'POST'})).status,405);
  assert.equal((await fetch(`${base}/api/library/roots/%ZZ/location`)).status,400);

  await page.locator('#library-mounts > summary').click();
  assert.equal(await page.getByRole('button', {name:'打开媒体库：项目归档', exact:true}).isVisible(), false);
  await page.locator('#library-mounts > summary').click();
  await page.getByRole('button', {name:'打开媒体库：项目归档', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#source-list .library-folder .source-meta').count(), 0, 'directory rows show only their name');
  assert.equal(await page.locator('#source-list .source-file .source-meta-origin').count(), 0, 'files inside a library do not repeat its name');
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    await page.evaluate(theme => {document.documentElement.dataset.theme=theme;}, theme);
    await page.waitForTimeout(300);
    await page.screenshot({path:`/tmp/voidplayer-library-directory-${engine}-${theme}.png`});
  }
  await page.emulateMedia({colorScheme:'light'});
  await page.getByRole('button', {name:'打开目录：实验一', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#library-location').inputValue(), '实验一');
  const historyStep = async direction => {
    await page.locator(`.crumbs-${direction}`).click();
    await page.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy') === 'false');
  };
  await historyStep('back');
  assert.equal(await page.locator('#library-location').inputValue(), '项目归档');
  assert.equal(await page.locator('.crumbs-forward').isDisabled(), false);
  await historyStep('forward');
  assert.equal(await page.locator('#library-location').inputValue(), '实验一');
  assert.equal(await page.locator('.crumbs-forward').isDisabled(), true);
  await search('clip-069');
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 1);
  await go('library:archive'); await historyStep('back');
  assert.equal(await page.locator('#library-location').inputValue(), 'clip-069', 'back restores the search in the visited directory');
  assert.equal(await page.locator('#source-list .source-file').count(), 1);
  await clearSearch();
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 60);
  await page.locator('#library-location').focus();
  assert.equal(await page.locator('#library-location').inputValue(), '');
  assert.equal(await page.locator('#library-location').getAttribute('placeholder'), '实验一 下搜索');
  await clearSearch();
  const pathbar = page.locator('#library-pathbar');
  assert.deepEqual(await pathbar.locator('.library-path-label').allTextContents(), ['媒体库', '项目归档', '实验一']);
  await pathbar.locator('.library-path-separator').first().click();
  await page.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#library-location').inputValue(), '项目归档', 'the separator belongs to the following path button instead of creating a dead click area');
  await historyStep('back');
  await pathbar.locator('button').first().hover(); await page.waitForTimeout(450);
  assert.equal(await page.locator('#control-tooltip').isVisible(), false, 'path buttons never display a tooltip');
  const pathBox = await pathbar.boundingBox(), footBox = await page.locator('#source-foot').boundingBox();
  assert.ok(Math.abs(pathBox.y - footBox.y) < 1, 'path bar remains above the source status');
  assert.equal(await pathbar.evaluate(bar => getComputedStyle(bar).borderTopWidth), '0px');
  await page.evaluate(() => {
    window.copiedLibraryPaths = [];
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async value => window.copiedLibraryPaths.push(value)}});
  });
  for (const [name, expected] of [['媒体库', 'library:/'], ['项目归档', 'library:archive'], ['实验一', 'library:archive/实验一']]) {
    await pathbar.getByRole('button', {name, exact:true}).click({button:'right'});
    await page.locator('#library-path-menu [data-action=copy-library-path]').click();
    assert.equal(await page.evaluate(() => window.copiedLibraryPaths.at(-1)), expected);
  }
  await pathbar.locator('[aria-current]').focus(); await page.keyboard.press('Shift+F10');
  await page.locator('#library-path-menu [data-action=copy-library-path]').click();
  const copiedLink = await page.evaluate(() => window.copiedLibraryPaths.at(-1));
  await pathbar.locator('[aria-current]').press('Shift+F10');
  await page.locator('#library-location').click();
  assert.equal(await page.locator('#library-path-menu').evaluate(menu => menu.matches(':popover-open')), false, 'outside click dismisses the path menu');
  await clearSearch();
  const file = page.locator('#source-list .source-file').first();
  await file.dispatchEvent('contextmenu', {clientX:1100, clientY:130});
  await pathbar.locator('[aria-current]').press('Shift+F10');
  assert.equal(await page.locator('#library-file-menu').evaluate(menu => menu.matches(':popover-open')), false, 'path menu replaces the file menu');
  assert.equal(await page.locator('#library-path-menu').evaluate(menu => menu.matches(':popover-open')), true);
  await file.dispatchEvent('contextmenu', {clientX:1100, clientY:130});
  assert.equal(await page.locator('#library-path-menu').evaluate(menu => menu.matches(':popover-open')), false, 'file menu replaces the path menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name:'打开目录：folder-0', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#source-list').getAttribute('aria-busy') === 'false');
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(), 'folder-0');
  assert.equal(await page.locator('#source-list .source-file').count(), 0);
  assert.equal(await page.locator('.crumbs-forward').isDisabled(), true, 'new navigation after back drops the abandoned forward branch');
  await historyStep('back');
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(), '实验一');
  await historyStep('forward');
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(), 'folder-0');
  const leaf = await pathbar.locator('[aria-current]').boundingBox();
  assert.ok(leaf.x >= pathBox.x && leaf.x + leaf.width <= pathBox.x + pathBox.width + 1, 'current folder stays visible in the long trail');
  await pathbar.getByRole('button', {name:'实验一', exact:true}).focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 60);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().tracks.length), 0, 'navigation never opens media');
  await go('library:/');
  await page.screenshot({path:`/tmp/voidplayer-library-root-${engine}.png`});
  await page.locator('#library-location').fill(copiedLink);
  await page.locator('#library-location').dispatchEvent('keydown', {key:'Enter', isComposing:true});
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(), '媒体库', 'IME confirmation does not navigate');
  await go(copiedLink);
  assert.deepEqual(protocolSearches, [], 'location protocols are never submitted as search terms');
  assert.equal(await page.locator('#library-location').inputValue(), '实验一');
  const webLink = new URL(base); webLink.searchParams.set('library','1'); webLink.searchParams.set('root','archive'); webLink.searchParams.set('dir','实验一');
  const linked = await context.newPage(); await linked.goto(webLink.href);
  await linked.waitForFunction(() => document.querySelector('#library-location')?.value === '实验一');
  assert.equal(await linked.locator('#sources-panel').isVisible(), true);
  assert.equal(await linked.locator('#library-pathbar [aria-current] .library-path-label').textContent(), '实验一');
  await linked.close(); await go(webLink.href);
  await page.locator('#library-location').fill('https://other.example/?library=1'); await page.locator('#library-location').press('Enter');
  await page.locator('.toast-stack .toast').filter({hasText:'另一个媒体服务'}).waitFor(); await clearSearch();
  if (process.argv.includes('--links-only')) {
    assert.deepEqual(errors, []); console.log(`PASS ${engine}: mounted-library roots, shared location/search field, breadcrumb navigation and path-copy menu`);
  } else {
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 60);
  const initialNode = await page.locator('#source-list .source-row').first().elementHandle();
  await page.locator('#source-list').evaluate(list => {list.scrollTop = list.scrollHeight;});
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 70);
  assert.equal(await page.locator('#source-list .library-folder').count(), 66);
  assert.ok(await initialNode.evaluate(node => node.isConnected), 'pagination preserves row identity');
  libraryNow += 31000; await writeFile(path.join(clips,'aaa-new.mp4'),'new');
  await page.waitForFunction(() => document.querySelector('#source-list').textContent.includes('aaa-new'));
  await go('library:/'); assert.equal(await page.locator('#library-recents .panel-empty').textContent(), '暂无最近片源');
  await go('library:archive/实验一');
  await page.route('**/api/library/browse?**', async route => {
    if (new URL(route.request().url()).searchParams.get('search')) await new Promise(resolve => setTimeout(resolve,300));
    await route.continue();
  });
  const beforeSearch = await page.locator('#source-list').innerText();
  await search('clip-069'); assert.equal(await page.locator('#source-list').innerText(), beforeSearch);
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 1);
  const fileRow = page.locator('#source-list .source-file');
  assert.equal(await fileRow.locator('.source-open').count(), 1, 'one main button owns source addition');
  assert.deepEqual(await fileRow.evaluate(el => {const s=getComputedStyle(el);return [s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft];}), ['4px','4px','4px','4px']);
  await page.locator('#source-list').getByRole('button',{name:'添加到视图：实验一/clip-069.mp4',exact:true}).click();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy);
  await fileRow.evaluate(el => el.click());
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().tracks.length), 1, 'repeated row activation never duplicates a loaded source');
  const workspace = await page.evaluate(() => window.voidPlayer.exportWorkspace());
  assert.equal(workspace.layout.sources.directory,'实验一'); assert.equal(workspace.layout.sources.query,'clip-069');
  await go('library:archive'); await search('deep');
  await page.evaluate(value => window.voidPlayer.importWorkspace(value),workspace);
  assert.equal(await page.locator('#library-location').inputValue(),'clip-069');
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(),'实验一');
  await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 1);
  await go('library:/'); assert.ok(await page.locator('#library-recents .source-row').count() > 0);
  await page.locator('#library-recents > summary').click();
  assert.equal(await page.locator('#library-recents .source-row').first().isVisible(), false);
  await page.locator('#library-recents > summary').click();
  await search('最近搜索'); const old = await page.evaluate(() => window.voidPlayer.exportWorkspace());
  old.layout.sources.tab = 'recent'; old.layout.sources.search = '';
  await go('library:archive'); await page.evaluate(value => window.voidPlayer.importWorkspace(value),old);
  assert.equal(await page.locator('#library-location').inputValue(),'最近搜索');
  assert.equal(await pathbar.locator('[aria-current] .library-path-label').textContent(),'媒体库');
  await page.reload(); await page.locator('#start-library-list').getByRole('button',{name:'打开：实验一/clip-069.mp4',exact:true}).waitFor();
  await page.locator('#toggle-sources').click(); await go('library:archive'); await search('deep');
  await page.waitForFunction(() => document.querySelector('#source-list').textContent.includes('deep-clip.mp4'));
  await clearSearch(); await go('library:archive');
  await page.waitForFunction(() => document.querySelector('#source-list').textContent.includes('sample.mp4'));
  await rename(media,media+'-offline'); await library.refresh(); await page.locator('#library-location').focus();
  await page.waitForFunction(() => document.querySelector('#source-list [aria-label="添加到视图：sample.mp4"]')?.getAttribute('aria-disabled') === 'true');
  assert.match(await page.locator('#source-list').innerText(),/存储离线/);
  await rename(media+'-offline',media); await library.refresh();
  await page.waitForFunction(() => document.querySelector('#source-list [aria-label="添加到视图：sample.mp4"]')?.getAttribute('aria-disabled') === 'false');
  const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
  const entry = library.browse().entries.find(e => e.name === 'sample.mp4');
  await call('load_library_item', { slot: 'A', id: entry.id });
  await call('add_review_mark', { slot: 'A', text: 'Version anchor' });
  const saved = await call('export_workspace');
  assert.ok(saved.media[0].source.url.includes('?v='));
  // Download URLs and file-location URLs must still work with the version query.
  const download = await page.evaluate(() => document.querySelector('#source-action-A').getAttribute('data-action')); assert.equal(download, 'download');
  const downloaded = page.waitForEvent('download'); await page.locator('#source-action-A').click(); assert.equal((await downloaded).suggestedFilename(), 'sample.mp4');
  // Rewrite the very same bytes under a different mtime: identity is (basename,
  // size), so this is an mtime-only drift, while the service's ctime/inode churn
  // rotates ?v= by itself. Resetting utimes to the recorded 1000s would make the
  // rewrite invisible to identity and leave the warning path untested.
  const bytes = await readFile(sample); await new Promise(r => setTimeout(r, 5)); await writeFile(sample, bytes); await utimes(sample, 2000, 2000); await library.refresh();
  assert.notEqual(library.browse().entries.find(e => e.name === 'sample.mp4').version, entry.version);
  assert.notEqual(library.browse().entries.find(e => e.name === 'sample.mp4').lastModified, entry.lastModified, 'the fixture must drift the recorded mtime while keeping the bytes');
  // mtime-only drift restores with a warning instead of pending relink. Observe
  // the toast stack before importing: the warning toast is informational and
  // auto-dismisses after 5s, while the restore still has to index and decode the
  // source, so an observer attached afterwards can miss it on a slow machine.
  const mtimeWarning = page.locator('.toast').filter({ hasText: '修改时间与工作区记录不一致' }).waitFor({ timeout: 30000 });
  await page.evaluate(value => window.voidPlayer.importWorkspace(value), saved);
  await page.waitForFunction(() => { const state = window.voidPlayer.getState(); return state.tracks.length > 0 && !state.busy && state.tracks.every(t => !!t.frame); });
  await mtimeWarning;
  // A real byte change (size differs) still refuses with a field-level message.
  await writeFile(sample, Buffer.concat([bytes, Buffer.from([0])])); await library.refresh();
  await page.evaluate(value => window.voidPlayer.importWorkspace(value), saved);
  const unavailable = await page.evaluate(() => window.voidPlayer.getState());
  assert.deepEqual(unavailable.tracks, []);
  const warning = page.locator('.toast-warning').filter({hasText:'以下片源无法打开，已跳过'});
  assert.match(await warning.innerText(), /已发生变化/);
  assert.match(await warning.innerText(), /大小/);
  assert.equal(await warning.locator('.toast-action').count(),0);
  assert.deepEqual(unavailable.marks, saved.marks);
  await writeFile(sample, bytes); await utimes(sample, 1000, 1000); await library.refresh();
  assert.deepEqual(unavailable.marks, saved.marks);
  // A legacy reference with matching recorded metadata is migrated to a version URL.
  const legacyWorkspace = structuredClone(saved); for (const media of legacyWorkspace.media) media.source.url = media.source.url.split('?')[0];
  await page.evaluate(value => window.voidPlayer.importWorkspace(value), legacyWorkspace);
  assert.ok((await call('export_workspace')).media[0].source.url.includes('?v='));
  await page.screenshot({ path: `/tmp/voidplayer-library-light-${engine}.png` });
  await page.locator('#settings-open').click(); await page.locator('[data-theme-choice=dark]').click(); await page.locator('#settings-close').click();
  await page.waitForFunction(() => !document.querySelector('#settings').open); await page.screenshot({ path: `/tmp/voidplayer-library-dark-${engine}.png` });
  assert.deepEqual(legacy, [], 'UI and Agent must not fetch the capped flat listing'); assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: mounted libraries, collapsible history, scoped search, continuous scrolling, index invalidation, workspace restore, versioned download, mtime-tolerant restore with warning, size-change refusal and legacy workspace migration`);
  }
} finally {
  await browser.close(); await new Promise(r => server.close(r)); await library.close(); await rm(directory, { recursive: true, force: true });
}
