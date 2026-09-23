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

  async function check(name, run, options = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', ...options });
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

  await check('empty recent list and current identity', async page => {
    const empty = page.locator('#start-library-list .start-library-empty');
    await empty.waitFor();
    assert.equal(await empty.locator('svg').count(), 1);
    assert.match(await empty.textContent(), /还没有最近打开的视频/);
    const list = await page.locator('#start-library-list').boundingBox();
    const hint = await empty.boundingBox();
    assert.ok(Math.abs(hint.x + hint.width / 2 - (list.x + list.width / 2)) < 2);
    assert.ok(Math.abs(hint.y + hint.height / 2 - (list.y + list.height / 2)) < 2);
    await page.waitForFunction(() => document.querySelector('#start-identity')?.textContent?.startsWith('当前身份 · '));
    assert.equal(await page.locator('#start-identity').evaluate(el => {
      const value = el.querySelector('.start-identity-name');
      return !!value && getComputedStyle(value).color !== getComputedStyle(el).color;
    }), true, 'only the identity value uses the accent color');
    const version = page.locator('#start-version-about');
    assert.equal(await version.textContent(), `VoidPlayer · ${await page.locator('#settings-pane-about .about-project-row').first().locator('span').nth(1).textContent()}`);
    await version.hover();
    assert.equal(await version.evaluate(el => getComputedStyle(el).color),
      await page.locator('#start-identity .start-identity-name').evaluate(el => getComputedStyle(el).color),
      'hovered version uses the theme color');
    await version.click();
    assert.equal(await page.locator('#settings-pane-about').isVisible(), true);
    await page.locator('#settings-close').click();
    await page.waitForFunction(() => !document.getElementById('settings')?.open);
    assert.equal(await version.evaluate(el => document.activeElement === el), true, 'closing About restores focus to the version');
  });

  await check('brand effects can leave the toolbar and keep the About button usable', async page => {
    const brand = page.locator('#brand-about');
    assert.equal(await brand.locator('.brand-ch').count(), 0, 'legacy rolling letters must not run alongside random effects');
    await page.waitForTimeout(7400);
    assert.equal(await page.locator('.brand-effect').count(), 0, 'brand must stay still without hover');
    await brand.focus();
    assert.equal(await page.locator('.brand-effect').count(), 0, 'focus alone must not play an effect');
    await brand.hover();
    const effect = page.locator('body > .brand-effect');
    await effect.waitFor();
    assert.equal(await effect.evaluate(el => getComputedStyle(el).position), 'fixed');
    assert.equal(await effect.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    const first = (await effect.getAttribute('class')).split('--')[1];
    assert.ok(['glitch', 'scramble', 'scatter', 'flip'].includes(first));
    await page.mouse.move(400, 90);
    assert.equal(await effect.count(), 0, 'effect stops when the pointer leaves the brand');
    await brand.hover();
    assert.notEqual((await effect.getAttribute('class')).split('--')[1], first, 'consecutive effects should differ');
    await brand.click();
    assert.equal(await page.locator('#settings-pane-about').isVisible(), true);
  }, { reducedMotion: 'no-preference' });

  await check('brand animation honors reduced motion', async page => {
    await page.locator('#brand-about').hover();
    assert.equal(await page.locator('.brand-effect').count(), 0);
  });

  await check('shortcut help and button tooltips use this platform', async page => {
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl');
    assert.equal(await page.locator('#settings-open').getAttribute('data-tooltip'), `打开设置 (${modifier} + ,)`);
    assert.equal(await page.locator('#previous').getAttribute('data-tooltip'), '上一帧 (←)');
    await page.locator('#settings-open').click();
    await page.locator('#settings-tab-shortcuts').click();
    const settingsKeys = page.locator('#settings-pane-shortcuts .settings-section').first().locator('.shortcut-row').filter({ hasText: '打开设置' }).locator('kbd');
    assert.equal(await settingsKeys.count(), 1);
    assert.equal(await settingsKeys.textContent(), `${modifier} + ,`);
    for (const [id, label, key] of [['inspector', '轨道信息', '·'], ['analysis', '码流分析', '1'], ['subtracks', '子轨道', '2'], ['sources', '片源', '3']]) {
      const row = page.locator('#settings-pane-shortcuts .shortcut-row').filter({ has: page.locator(`span:text-is("${label}")`) });
      assert.equal(await row.count(), 1);
      assert.equal(await row.locator('kbd').textContent(), `Ctrl + ${key}`);
      assert.match(await page.locator(`#toggle-${id}`).getAttribute('data-tooltip'), new RegExp(` \\(Ctrl \\+ ${key}\\)$`));
    }
  });

  await check('left-hand panel shortcuts toggle four panels', async page => {
    const entry = listing.entries.find(item => item.name === 'ci_h264_smoke.mp4');
    await page.evaluate(async id => {
      await window.voidPlayer.tools.find(tool => tool.name === 'load_library_item').execute({ id, slot: 'A' });
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, entry.id);
    for (const [id, key] of [['inspector', 'Control+Backquote'], ['analysis', 'Control+1'], ['subtracks', 'Control+2'], ['sources', 'Control+3']]) {
      const button = page.locator(`#toggle-${id}`);
      const before = await button.getAttribute('aria-expanded');
      await page.keyboard.press(key);
      assert.notEqual(await button.getAttribute('aria-expanded'), before, `${id} opens via ${key}`);
      await page.keyboard.press(key);
      assert.equal(await button.getAttribute('aria-expanded'), before, `${id} closes via ${key}`);
    }
  });

  await check('RGB control explains the required color pipeline before opening YUV choices', async page => {
    const entry = listing.entries.find(item => item.name === 'ci_h264_smoke.mp4');
    await page.evaluate(async id => window.voidPlayer.tools.find(tool => tool.name === 'load_library_item').execute({ id, slot: 'A' }), entry.id);
    const channel = page.locator('#channel-select');
    await page.waitForFunction(() => !document.getElementById('channel-select').disabled);
    await channel.click();
    assert.match(await page.locator('.toast-message').last().textContent(), /切换为“自有色彩”/);
    assert.equal(await page.locator('#channel-select-menu').evaluate(menu => menu.matches(':popover-open')), false);
    await page.locator('.toast-action').last().click();
    assert.equal(await page.locator('#settings-tab-performance').getAttribute('aria-selected'), 'true');
    await page.locator('[data-color-mode=reference]').click();
    await page.waitForFunction(() => window.voidPlayer.getState().colorMode === 'reference');
    assert.equal(await page.locator('[data-color-mode=reference]').evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    assert.equal(await page.locator('.color-flow-note').evaluate(el => getComputedStyle(el).fontSize), await page.locator('.color-flow-footnote').evaluate(el => getComputedStyle(el).fontSize));
    await page.locator('#settings-close').click();
    await page.locator('#settings').waitFor({ state: 'hidden' });
    await channel.click();
    assert.equal(await page.locator('#channel-select-menu').evaluate(menu => menu.matches(':popover-open')), true);
    assert.equal(await page.locator('#channel-select-menu [data-value=y]').count(), 1);
  });

  await check('topbar keeps every control visible across viewport widths', async page => {
    for (const width of [320, 375, 480, 600, 680, 681, 793, 900, 1120, 1121, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.topbar');
        const header = bar.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.topbar button')]
          .filter(button => getComputedStyle(button).display !== 'none' && button.getBoundingClientRect().width > 0)
          .map(button => ({ id: button.id || button.textContent.trim(), rect: button.getBoundingClientRect().toJSON() }));
        return { overflow: document.documentElement.scrollWidth > innerWidth, header: header.toJSON(), scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, buttons };
      });
      assert.equal(layout.overflow, false, `${width}px document overflow`);
      for (const { id, rect } of layout.buttons) {
        assert.ok(rect.top >= layout.header.top - 1 && rect.bottom <= layout.header.bottom + 1, `${width}px wraps ${id}`);
        if (layout.scrollWidth === layout.clientWidth) assert.ok(rect.left >= -1 && rect.right <= width + 1, `${width}px clips ${id}`);
      }
      if (width >= 600) assert.equal(layout.scrollWidth, layout.clientWidth, `${width}px toolbar should fit on one line`);
      else if (layout.scrollWidth > layout.clientWidth) {
        await page.locator('.topbar').evaluate(bar => { bar.scrollLeft = bar.scrollWidth; });
        const settings = await page.locator('#settings-open').boundingBox();
        assert.ok(settings.x >= -1 && settings.x + settings.width <= width + 1, `${width}px settings is reachable by horizontal scroll`);
      }
      assert.ok(layout.buttons.some(button => button.id === 'settings-open'), `${width}px settings remains visible`);
    }
  });

  await check('warning toasts remain above settings and clickable before and after modal opens', async page => {
    const triggerWarning = () => page.evaluate(() => window.voidPlayer.loadFile('A', new File(['invalid'], 'broken.flv')).catch(() => {}));
    const warning = page.locator('.toast-warning');
    const assertTop = async () => {
      await warning.waitFor({ state: 'visible' });
      await settle(page);
      assert.equal(await warning.locator('.toast-close').evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true, 'toast receives pointer events above modal backdrop');
    };
    await triggerWarning();
    await page.locator('#settings-open').click();
    await assertTop();
    await warning.locator('.toast-close').click();
    await warning.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#settings').evaluate(el => el.open), true);
    await triggerWarning();
    await assertTop();
    await warning.locator('.toast-action').click();
    assert.equal(await page.locator('#settings-tab-logs').getAttribute('aria-selected'), 'true');
    await warning.waitFor({ state: 'detached' });
    await triggerWarning();
    await page.locator('#settings-close').click();
    await page.waitForFunction(() => !document.querySelector('#settings').open);
    await assertTop();
    await warning.locator('.toast-close').click();
    await warning.waitFor({ state: 'detached' });
  });

  await check('HLG Dolby sample explains SDR restriction in a warning toast and plays in browser color', async page => {
    const id = listing.entries.find(item => item.name === 'dolby_hlg_1080p30.mp4').id;
    const error = await page.evaluate(async id => {
      const tool = name => window.voidPlayer.tools.find(t => t.name === name);
      await tool('set_review_color_mode').execute({ mode: 'reference' });
      try { await tool('load_library_item').execute({ id, slot: 'A' }); }
      catch (error) { return error.message; }
    }, id);
    assert.match(error, /HDR/);
    const warning = page.locator('.toast-warning');
    await warning.waitFor({ state: 'visible' });
    assert.equal(await warning.count(), 1);
    assert.equal(await page.locator('#notice').count(), 0);
    await warning.locator('.toast-action').click();
    assert.equal(await page.locator('#settings-tab-performance').getAttribute('aria-selected'), 'true');
    await page.locator('[data-color-mode=browser]').click();
    await page.waitForFunction(() => window.voidPlayer.getState().colorMode === 'browser');
    await page.locator('#settings-close').click();
    await page.evaluate(async id => window.voidPlayer.tools.find(t => t.name === 'load_library_item').execute({ id, slot: 'A' }), id);
    await page.locator('#play').click();
    await page.waitForFunction(() => window.voidPlayer.getState().positionUs > 500000);
    await page.locator('#play').click();
    const state = await page.evaluate(() => window.voidPlayer.getState());
    assert.ok(state.tracks[0].frame && !state.tracks[0].failure);
    assert.equal(state.error, null);
    await page.screenshot({ path: path.join(screenshots, `${browserName}-dolby-browser-color.png`) });
  });

  await check('paused AV1 frame retains its pixels and aspect ratio after hiding and showing', async page => {
    await page.setViewportSize({ width: 791, height: 797 });
    const id = listing.entries.find(item => item.name === 'av1_10s_1920x1080.webm').id;
    await page.evaluate(async id => window.voidPlayer.tools.find(t => t.name === 'load_library_item').execute({ id, slot: 'A' }), id);
    await panels(page, true);
    await settle(page);
    const executor = await page.locator('#canvas-A').getAttribute('data-color-executor');
    const surface = page.locator(executor?.startsWith('webgpu') ? '#stage-A .frame-presentation:not([role])' : '#stage-A .frame-presentation[role="img"]');
    const geometry = () => surface.evaluate(c => ({ width: c.width, height: c.height, box: [c.clientWidth, c.clientHeight] }));
    const before = await geometry();
    const pixels = await surface.screenshot();
    const eye = page.locator('[data-track-drag="A"] .track-visibility');
    for (const restoreAll of [false, true]) {
      await eye.click(); await settle(page);
      assert.equal(await page.locator('#tracks-hidden').isVisible(), true);
      if (restoreAll) await page.locator('#show-all-tracks').click();
      else await eye.click();
      await eye.focus(); await settle(page);
      assert.deepEqual(await geometry(), before, 'restored surface must retain its viewport-sized backing dimensions');
      assert.deepEqual(await surface.screenshot(), pixels, 'paused frame pixels and letterboxing must survive hiding');
    }
    console.log(`  Retained frame verified at DPR 2 (${executor})`);
  }, { deviceScaleFactor: 2 });

  await check('track visibility toggles, reflows split view and survives workspace restore', async page => {
    const ids = ['ci_h264_smoke.mp4', 'h264_9s_1920x1080.mp4'].map(name => listing.entries.find(item => item.name === name).id);
    await page.evaluate(async ids => {
      const load = window.voidPlayer.tools.find(t => t.name === 'load_library_item');
      for (const [i, id] of ids.entries()) await load.execute({ id, slot: ['A', 'B'][i] });
      window.voidPlayer.setViewport({ mode: 'split' });
    }, ids);
    await panels(page, true);
    await page.setViewportSize({ width: 791, height: 797 });
    const placeholder = page.locator('#tracks-hidden');
    assert.equal(await placeholder.isVisible(), false);
    const eye = page.locator('[data-track-drag="A"] .track-visibility');
    const eyeBox = await eye.boundingBox(), laneBox = await page.locator('[data-track-drag="A"] .track-lane').boundingBox();
    assert.ok(eyeBox.x >= laneBox.x + laneBox.width, 'visibility belongs at the right edge of the track row');
    assert.equal(await page.locator('.subtrack-row[data-track-drag="A"] .remove-track').count(), 0);
    await eye.click(); await settle(page);
    assert.equal(await page.locator('.video-card[data-slot="A"]').isVisible(), false);
    assert.equal(await page.locator('.video-card[data-slot="B"]').isVisible(), true);
    assert.equal(await page.locator('.screens').evaluate(el => el.classList.contains('split')), false);
    assert.equal(await eye.getAttribute('aria-label'), '显示轨道 A');
    const saved = await page.evaluate(async () => window.voidPlayer.tools.find(t => t.name === 'export_workspace').execute({}));
    assert.equal(saved.tracks[0].visible, false);
    await eye.click(); await settle(page);
    assert.equal(await page.locator('.video-card[data-slot="A"]').isVisible(), true);
    assert.equal(await page.locator('.screens').evaluate(el => el.classList.contains('split')), true);
    await page.evaluate(async document => window.voidPlayer.tools.find(t => t.name === 'import_workspace').execute({ document }), saved);
    await settle(page);
    assert.equal(await page.locator('.video-card[data-slot="A"]').isVisible(), false);
    await page.locator('[data-track-drag="B"] .track-visibility').click(); await settle(page);
    assert.equal(await page.locator('.video-card:visible').count(), 0);
    assert.equal(await placeholder.isVisible(), true);
    await page.screenshot({ path: path.join(screenshots, `${browserName}-all-tracks-hidden.png`) });
    await page.emulateMedia({ colorScheme: 'dark' });
    await settle(page);
    await page.screenshot({ path: path.join(screenshots, `${browserName}-all-tracks-hidden-dark.png`) });
    await eye.click(); await settle(page);
    assert.equal(await placeholder.isVisible(), false);
    await eye.click(); await settle(page);
    await page.locator('#show-all-tracks').click(); await settle(page);
    assert.equal(await placeholder.isVisible(), false);
    assert.equal(await page.locator('.video-card:visible').count(), 2);
    assert.equal(await page.locator('.video-card[data-slot="A"]').isVisible(), true);
    await page.screenshot({ path: path.join(screenshots, `${browserName}-track-visibility.png`) });
  });

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
    await page.setViewportSize({ width: 1280, height: 800 });
    await panels(page, false);
    await page.evaluate(() => window.voidPlayer.setViewport({ mode: 'split', splitPos: .15 }));
    await settle(page);
    const splitHeader = await page.evaluate(() => {
      const screens = document.querySelector('.screens').getBoundingClientRect();
      const a = document.querySelector('#copy-path-A').getBoundingClientRect();
      const b = document.querySelector('.view-second .card-heading').getBoundingClientRect();
      const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
      return { aCenter: a.left + a.width / 2, bLeft: b.left, expectedBLeft: screens.left + screens.width / 2, aCopyHit: !!hit?.closest('#copy-path-A') };
    });
    assert.ok(splitHeader.aCenter > 1280 * .15, 'A controls remain past the moved video seam');
    assert.ok(Math.abs(splitHeader.bLeft - splitHeader.expectedBLeft) <= 1, 'B heading stays at the center');
    assert.equal(splitHeader.aCopyHit, true, 'A copy button receives clicks above the drawing surface');
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
      const panelBox = await page.locator('#sources-panel').boundingBox();
      const footBox = await page.locator('#source-foot').boundingBox();
      const files = await page.locator('#source-list').boundingBox();
      const searchToggle = await page.locator('#sources-search-toggle').boundingBox();
      const scopeTrigger = await page.locator('#library-root').boundingBox();
      const listPadBottom = await page.locator('#source-list').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
      assert.ok(Math.abs(listPadBottom - footBox.height) <= 1, 'list bottom padding reserves exactly the floating foot height');
      assert.ok(Math.abs((footBox.y + footBox.height) - (panelBox.y + panelBox.height)) <= 1, 'foot pinned to panel bottom');
      const localBox = await page.locator('#local-sources').boundingBox();
      const activityBox = await page.locator('#source-activity').boundingBox();
      assert.ok(localBox.y + localBox.height <= activityBox.y + 1, 'local section stacks above activity inside the foot');
      const listPaddingTop = await page.locator('#source-list').evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
      const toolsHeight = await page.locator('#source-tools').evaluate(el => el.getBoundingClientRect().height);
      assert.ok(Math.abs(listPaddingTop - toolsHeight) <= 1, 'list top padding reserves exactly the floating tools height');
      assert.ok(searchToggle.y + searchToggle.height <= files.y + listPaddingTop + 1, 'floating tools stay within the list top padding');
      assert.equal(searchToggle.y, scopeTrigger.y);
      await page.locator('#sources-search-toggle').click();
      assert.equal(await page.locator('#source-search').evaluate(el => document.activeElement === el), true, 'search toggle focuses the input');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#source-search-field').isHidden(), true, 'escape closes search');
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
    await page.locator('#library-root').click();
    await page.locator('#library-root-menu').getByRole('menuitemradio', { name: '最近使用', exact: true }).click();
    await firstRow.getByRole('button', { name: '从视图移除：same.mp4', exact: true }).click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1);
    assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().tracks.map(t => t.source.id)), [entries[1].id]);
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    await page.waitForFunction(() => document.querySelectorAll('#start-library-list .start-recent-row').length === 2);
    const rows = await page.locator('#start-library-list .start-recent-row').allTextContents();
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
