// UI regressions against a fresh build, with an isolated local server and browser.
// Usage: npm run test:browser -- [webkit|chromium]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, utimes, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';

const root = path.resolve(import.meta.dirname, '..');
const browserName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName), 'Expected webkit or chromium');
const fixtures = path.join(root, 'fixtures/video');
const screenshots = path.join(root, 'artifacts', 'source-activity');
await mkdir(screenshots, { recursive: true });
await access(path.join(root, 'dist/index.html'));
const temporary = await mkdtemp(path.join(tmpdir(), 'voidplayer-browser-'));
let browser, server;
try {
  // Different library roots, identical names, bytes and modification times.
  const roots = ['camera-a', 'camera-b'].map(name => path.join(temporary, name));
  for (const folder of roots) {
    await mkdir(folder);
    const file = path.join(folder, 'same.mp4');
    await copyFile(path.join(fixtures, 'ci_h264_smoke.mp4'), file);
    await utimes(file, 1000, 1000);
  }
  const library = new MediaLibraryIndex([fixtures, ...roots]);
  const listing = await library.list();
  server = createMediaServer({ roots: library.roots, library, staticDir: path.join(root, 'dist'), onLog() {} });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true,...(browserName==='chromium'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{}) });

  async function check(name, run) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    // ResizeObserver errors are failures too; never mask the regression being tested.
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(base);
      await page.waitForFunction(() => window.voidPlayer);
      await run(page);
      await settle(page);
      assert.deepEqual(errors, [], `${name}: unexpected browser errors`);
      console.log(`PASS ${name}`);
    } finally { await page.close(); }
  }
  async function settle(page) {
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }));
  }
  async function panels(page, open) {
    for (const panel of ['inspector', 'sources', 'subtracks']) {
      const button = page.locator(`#toggle-${panel}`);
      if (await button.getAttribute('aria-expanded') !== String(open)) await button.click();
    }
  }

  await check('resize, split/grid layout, focus mode and track-close focus', async page => {
    const names = ['h264_9s_1920x1080.mp4', 'mpeg2_10s_1280x720.ts', 'mhw_hevc_fullrange_bt709_3s.mp4', 'h265_10s_1920x1080.mp4', 'ci_h264_smoke.mp4', 'vp9_10s_1920x1080.webm', 'mhw_x265_aq_qg16_4s_1920x1080.mkv', 'av1_10s_1920x1080.webm'];
    const ids = names.map(name => {
      const entry = listing.entries.find(item => item.name === name);
      assert.ok(entry, `Missing fixture: ${name}`); return entry.id;
    });
    await page.evaluate(async ids => {
      const load = window.voidPlayer.tools.find(tool => tool.name === 'load_library_item');
      for (const [i, id] of ids.entries()) await load.execute({ id, slot: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'][i] });
      window.voidPlayer.setViewport({ arrangement: 'grid' });
    }, ids);
    for (const width of [1280, 600]) {
      await page.setViewportSize({ width, height: 800 });
      for (const open of [false, true]) {
        await panels(page, open);
        for (const mode of ['side-by-side', 'split']) {
          await page.evaluate(mode => window.voidPlayer.setViewport({ mode }), mode);
          await settle(page);
          const geometry = await page.evaluate(() => {
            const transport = document.querySelector('.transport');
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              height: transport.getBoundingClientRect().height,
              expectedHeight: parseFloat(getComputedStyle(transport).getPropertyValue('--transport-height')),
              visibleTracks: [...document.querySelectorAll('.video-card')].filter(card => !card.hidden).length,
              images: [...document.querySelectorAll('.video-card:not([hidden]) .image-wrap')].map(image => [image.offsetWidth, image.offsetHeight]),
            };
          });
          assert.equal(geometry.overflow, false);
          assert.equal(geometry.height, geometry.expectedHeight);
          assert.equal(geometry.visibleTracks, mode === 'split' ? 2 : 8);
          assert.ok(geometry.images.every(([w, h]) => w > 0 && h > 0));
        }
      }
    }
    // Repeat with real panel transitions enabled, including reversals while resizing.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await panels(page, false); await panels(page, true); await panels(page, false);
    await page.waitForFunction(() => !document.getElementById('workspace').classList.contains('panel-motion'));
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    await page.evaluate(() => window.voidPlayer.setViewport({ mode: 'side-by-side', zoom: 2, offsetX: 20, offsetY: 15 }));
    await settle(page);
    await page.locator('#reset-view').click(); await settle(page);
    assert.equal(await page.evaluate(() => window.voidPlayer.getViewport().zoom), 1);
    const beforeFocus = await page.locator('#stage-A').boundingBox();
    const focusButton = await page.locator('#toggle-chrome').boundingBox();
    assert.equal(await page.locator('#toggle-chrome').getAttribute('data-tooltip'), '专注模式');
    await page.locator('#toggle-chrome').click(); await settle(page);
    assert.equal(await page.locator('.transport').evaluate(el => el.inert), true);
    assert.deepEqual(await page.locator('#stage-A').boundingBox(), beforeFocus);
    assert.deepEqual(await page.locator('#toggle-chrome').boundingBox(), focusButton, 'focus toggle stays in place');
    assert.equal(await page.locator('#toggle-chrome').getAttribute('data-tooltip'), '专注模式');
    await page.locator('#toggle-chrome').click();
    await page.locator('#remove-track-B').click();
    await page.waitForFunction(() => !window.voidPlayer.getState().tracks.some(track => track.slot === 'B'));
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.dragSurface), 'A');
    for (const slot of ['C', 'D', 'E', 'F', 'G', 'H', 'A']) await page.locator(`#remove-track-${slot}`).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'open');
  });

  await check('stalled source loads can be cancelled or replaced without locking the add buttons', async page => {
    const entries = listing.entries.filter(entry => entry.name === 'same.mp4');
    const stalled = [];
    await page.route(`**/api/media/${encodeURIComponent(entries[0].id)}?*`, route => { stalled.push(route); });
    await page.locator('#toggle-sources').click();
    const row = entry => page.locator('#source-list .source-row').filter({ hasText: entry.root }).filter({ hasText: 'same.mp4' });
    const add = entry => row(entry).getByRole('button', { name: '添加到视图：same.mp4', exact: true });
    const nextRequest = () => page.waitForRequest(request => new URL(request.url()).pathname === `/api/media/${encodeURIComponent(entries[0].id)}`);
    try {
      let request = nextRequest();
      await add(entries[0]).click();
      await request;
      const cancel = row(entries[0]).getByRole('button', { name: '取消载入：same.mp4', exact: true });
      await cancel.waitFor();
      assert.equal(await page.locator('#source-activity-stage').textContent(), '正在读取视频信息');
      assert.match(await page.locator('#source-activity-name').textContent(), /same\.mp4/);
      assert.equal(await page.locator('#source-activity-cancel').isVisible(), true);
      await page.waitForFunction(() => !document.getElementById('source-activity-time').textContent.includes('0 秒'));
      await page.setViewportSize({ width: 600, height: 800 });
      await settle(page);
      await page.locator('#source-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
      const activity = await page.locator('#source-activity').boundingBox();
      const files = await page.locator('#source-list').boundingBox();
      const importButton = await page.locator('#sources-import').boundingBox();
      const refreshButton = await page.locator('#sources-refresh').boundingBox();
      assert.ok(activity.y >= files.y + files.height - 1, 'load status stays below the scroll area');
      assert.ok(importButton.y + importButton.height <= files.y && importButton.x >= refreshButton.x + refreshButton.width - 1, 'import stays beside refresh above the list');
      assert.equal(importButton.y, refreshButton.y);
      await page.screenshot({ path: path.join(screenshots, `${browserName}-loading.png`) });
      await page.setViewportSize({ width: 1280, height: 800 });
      await settle(page);
      assert.equal(await add(entries[1]).isEnabled(), true);
      await page.locator('#source-activity-cancel').click();
      assert.equal(await page.locator('#source-activity-stage').textContent(), '已取消载入');
      await page.waitForFunction(() => !window.voidPlayer.getState().busy);
      assert.equal(await add(entries[0]).isEnabled(), true);
      request = nextRequest();
      await add(entries[0]).click();
      await request;
      await cancel.waitFor();
      await add(entries[1]).click();
      await page.waitForFunction(id => {
        const state = window.voidPlayer.getState();
        return !state.busy && state.tracks.length === 1 && state.tracks[0].source.id === id;
      }, entries[1].id, { timeout: 10000 });
      assert.equal(await page.evaluate(() => window.voidPlayer.getState().error), null);
      assert.equal(await add(entries[0]).isEnabled(), true);
      assert.equal(await page.locator('.source-row[aria-busy="true"]').count(), 0);
      assert.equal(await page.locator('#source-activity-stage').textContent(), '已上屏');
      assert.equal(await page.locator('#source-activity-cancel').isVisible(), false);
      await page.evaluate(() => window.voidPlayer.loadFile('A', new File([], 'empty.ts')).catch(() => {}));
      assert.equal(await page.locator('#source-activity-stage').textContent(), '载入失败');
      assert.match(await page.locator('#source-activity-hint').textContent(), /非空的视频文件/);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: path.join(screenshots, `${browserName}-error.png`) });
    } finally { await Promise.all(stalled.map(route => route.abort().catch(() => {}))); }
  });

  await check('distinct same-metadata sources load and survive history restore', async page => {
    const entries = listing.entries.filter(entry => entry.name === 'same.mp4');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].size, entries[1].size);
    assert.equal(entries[0].lastModified, entries[1].lastModified);
    await page.locator('#toggle-sources').click();
    for (const [i, entry] of entries.entries()) {
      const row = page.locator('#source-list .source-row').filter({ hasText: entry.root }).filter({ hasText: 'same.mp4' });
      await row.getByRole('button', { name: '添加到视图：same.mp4', exact: true }).click();
      await page.waitForFunction(count => window.voidPlayer.getState().tracks.length === count, i + 1);
    }
    const state = await page.evaluate(() => ({
      ids: window.voidPlayer.getState().tracks.map(track => track.source.id),
      history: JSON.parse(localStorage.getItem('voidplayer.sources.v1')).map(item => item.libraryId),
    }));
    assert.deepEqual(state.ids, entries.map(entry => entry.id));
    assert.deepEqual(new Set(state.history), new Set(state.ids));
    const firstRow = page.locator('#source-list .source-row').filter({ hasText: entries[0].root }).filter({ hasText: 'same.mp4' });
    await firstRow.getByRole('button', { name: '从视图移除：same.mp4', exact: true }).click();
    await page.waitForFunction(id => !window.voidPlayer.getState().tracks.some(t => t.source.id === id), entries[0].id);
    assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().tracks.map(t => t.source.id)), [entries[1].id], 'removing a source preserves the same-named file from another root');
    assert.equal(await firstRow.getByRole('button', { name: '添加到视图：same.mp4', exact: true }).isVisible(), true, 'removed source remains available to add');
    // Re-add, then remove the same source from the recent list.
    await firstRow.getByRole('button', { name: '添加到视图：same.mp4', exact: true }).click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 2);
    await page.locator('[data-source-tab="recent"]').click();
    await firstRow.getByRole('button', { name: '从视图移除：same.mp4', exact: true }).click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1);
    assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().tracks.map(t => t.source.id)), [entries[1].id]);
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    await page.locator('[data-start-tab="recent"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#start-library-list .source-row').length === 2);
    const rows = await page.locator('#start-library-list .source-row').allTextContents();
    assert.ok(entries.every(entry => rows.some(text => text.includes(entry.root))));
  });
  await check('canvas grid repaints for system theme changes without geometry changes', async page => {
    const id=listing.entries.find(e=>e.name==='ci_h264_smoke.mp4').id;
    await page.evaluate(id=>window.voidPlayer.tools.find(t=>t.name==='load_library_item').execute({slot:'A',id}),id);
    await page.emulateMedia({colorScheme:'light'});
    await page.addStyleTag({content:'@media (prefers-color-scheme: dark) { :root[data-theme] { --viewport-grid-line: #c0d0e0; } }'});
    await settle(page);
    const count=await page.locator('#grid-A').evaluate(e=>Number(e.dataset.gridDraws));
    assert.ok(count>0);
    await page.emulateMedia({colorScheme:'dark'});
    await page.waitForFunction(before=>Number(document.querySelector('#grid-A').dataset.gridDraws)>before,count);
    assert.equal(await page.locator('#grid-A').evaluate(e=>e.getContext('2d').strokeStyle),'#c0d0e0');
    const after=await page.locator('#grid-A').evaluate(e=>Number(e.dataset.gridDraws));
    await settle(page);
    assert.equal(await page.locator('#grid-A').evaluate(e=>Number(e.dataset.gridDraws)),after,'no continuous redraw while paused');
  });
  console.log(`Browser regressions passed (${browserName}); status screenshots saved under artifacts/source-activity.`);
} finally {
  try { await browser?.close(); }
  finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(temporary, { recursive: true, force: true });
  }
}
