// UI regressions against a fresh build, with an isolated local server and browser.
// Usage: npm run test:browser -- [webkit|chromium]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, utimes, rm, access, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';
import { checkScrollBoundary } from './testing/scroll-boundary.mjs';
import { build as buildFixture } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const browserName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName), 'Expected webkit or chromium');
const fixtures = path.join(root, 'fixtures/video');
const screenshots = path.join(root, 'artifacts', 'source-activity');
await mkdir(screenshots, { recursive: true });
await access(path.join(root, 'dist/index.html'));
const temporary = await mkdtemp(path.join(tmpdir(), 'voidplayer-browser-'));
let browser, server, library;
try {
  // Different library roots, identical names, bytes and modification times.
  const roots = ['camera-a', 'camera-b'].map(name => path.join(temporary, name));
  for (const folder of roots) {
    await mkdir(folder);
    const file = path.join(folder, 'same.mp4');
    await copyFile(path.join(fixtures, 'ci_h264_smoke.mp4'), file);
    await utimes(file, 1000, 1000);
  }
  const nested = path.join(roots[0], 'review', 'shots');
  await mkdir(nested, { recursive: true });
  await copyFile(path.join(fixtures, 'ci_h264_smoke.mp4'), path.join(nested, 'path-tooltip.mp4'));
  library = new MediaLibraryIndex([fixtures, ...roots]);
  const listing = await library.list();
  server = createMediaServer({ roots: library.roots, library, staticDir: path.join(root, 'dist'), onLog() {} });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true,...(browserName==='chromium'&&process.env.CHROME_EXECUTABLE_PATH?{executablePath:process.env.CHROME_EXECUTABLE_PATH}:{}) });

  let completedChecks = 0;
  async function check(name, run, options = {}) {
    const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9);
    if (filter && !name.includes(filter)) return;
    const page = await browser.newPage({locale:'zh-CN',  viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', ...options });
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
      completedChecks++; console.log(`PASS ${name}`);
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
    await page.waitForFunction(() => !document.getElementById('settings')?.open && document.activeElement === document.getElementById('start-version-about'));
    assert.equal(await version.evaluate(el => document.activeElement === el), true, 'closing About restores focus to the version');
  });

  await check('start header and identity confirmation stay on one row at narrow widths', async page => {
    for (const width of [1280, 581, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const header = await page.locator('.start-header').boundingBox();
      const title = await page.locator('.start-header > h3').boundingBox();
      const identity = await page.locator('#start-identity').boundingBox();
      const library = await page.locator('#start-library-more').boundingBox();
      assert.ok(Math.abs(title.y + title.height / 2 - (library.y + library.height / 2)) < 1);
      assert.ok(Math.abs(identity.y + identity.height / 2 - (library.y + library.height / 2)) < 1);
      assert.ok(library.x + library.width <= header.x + header.width + 1);
      const prefix = await page.locator('.start-identity-prefix').isVisible();
      assert.equal(prefix, (await page.locator('#start-panel').boundingBox()).width > 420, 'prefix responds to the width available to the recent panel');
      await page.locator('#start-identity').click();
      const combo = await page.locator('.identity-combo').boundingBox();
      const save = await page.locator('#identity-save').boundingBox();
      assert.ok(save.x >= combo.x + combo.width, 'confirmation stays to the right of the username field');
      assert.ok(Math.abs(save.y + save.height / 2 - (combo.y + combo.height / 2)) < 1);
      await page.locator('#settings-close').click();
      await page.waitForFunction(() => !document.querySelector('#settings').open);
    }
    await page.setViewportSize({ width: 581, height: 664 });
    await page.locator('#toggle-sources').click();
    const identity = await page.locator('#start-identity').boundingBox();
    const library = await page.locator('#start-library-more').boundingBox();
    assert.ok(Math.abs(identity.y + identity.height / 2 - (library.y + library.height / 2)) < 1);
    assert.equal(await page.locator('.start-identity-prefix').isVisible(), false);
    assert.equal(await page.locator('#start-library-more > span').isVisible(), true, '581px with sources retains the library action label');
    await page.screenshot({ path: path.join(screenshots, 'start-header-narrow.png') });
  });

  await check('keyboard focus uses a theme fill while mouse dropdowns have no focus ring', async page => {
    await page.locator('#toggle-sources').click();
    // macOS WebKit uses Option+Tab to include buttons in native focus navigation.
    const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const expected = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.background = 'color-mix(in srgb, var(--accent) 22%, var(--surface-panel))';
        document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value;
      });
      await page.locator('#library-location').click();
      await page.keyboard.press(tabKey);
      assert.equal(await page.locator('#library-root').evaluate(el => document.activeElement === el && el.matches(':focus-visible')), true);
      await page.waitForFunction(expected => getComputedStyle(document.getElementById('library-root')).backgroundColor === expected, expected);
      assert.equal(await page.locator('#library-root').evaluate(el => getComputedStyle(el).backgroundColor), expected);
      assert.equal(await page.locator('#library-navigation').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.keyboard.press('Enter');
      await page.locator('#library-root-menu').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#library-root-menu button:focus').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#library-root').evaluate(el => document.activeElement === el), true);
      await page.locator('#library-root').click();
      assert.equal(await page.locator('#library-root').evaluate(el => el.matches(':focus-visible')), false, 'mouse click does not activate the keyboard focus fill');
      assert.equal(await page.locator('#library-navigation').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.locator('#library-root').click();
      await page.keyboard.press(tabKey);
      assert.equal(await page.locator('#sources-search-toggle').evaluate(el => document.activeElement === el), true);
      await page.waitForFunction(expected => getComputedStyle(document.getElementById('sources-search-toggle')).backgroundColor === expected, expected);
      assert.equal(await page.locator('#sources-search-toggle').evaluate(el => getComputedStyle(el).backgroundColor), expected);
    }
  });

  await check('press feedback respects links, tabs and close colors; search overlays navigation', async page => {
    const insetButtons = await page.locator('button.icon-button').evaluateAll(buttons => buttons.filter(el => getComputedStyle(el).backgroundClip !== 'border-box').map(el => el.id || el.getAttribute('aria-label')));
    assert.deepEqual(insetButtons, [], 'all icon buttons paint their full background by default');
    const style = selector => page.locator(selector).evaluate(el => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color, transition: s.transitionDuration };
    });
    const press = async selector => {
      await page.locator(selector).hover(); await page.locator(selector).evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
      const hover = await style(selector);
      await page.mouse.down(); await page.locator(selector).evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
      const held = await style(selector);
      await page.mouse.move(0, 0); await page.mouse.up();
      return { hover, held };
    };
    const idle = await style('#server-status');
    const status = await press('#server-status');
    assert.notEqual(status.hover.background, idle.background);
    assert.notEqual(status.held.background, status.hover.background);
    assert.equal(status.held.transition, '0.24s, 0.24s');
    await page.locator('#settings-open').click();
    const tab = await press('#settings-tab-performance');
    assert.equal(tab.held.transition, '0s');
    assert.deepEqual(tab.held, tab.hover, 'holding a tab does not add a press fill');
    const close = await press('#settings-close');
    assert.equal(close.held.color, close.hover.color, 'close keeps its danger color');
    assert.notEqual(close.held.background, close.hover.background);
    await page.locator('#settings-close').click();
    await page.waitForFunction(() => !document.querySelector('#settings').open);
    await page.locator('#toggle-sources').click();
    await page.waitForTimeout(300);
    const materials = await page.locator('#source-tools').evaluate(tools =>
      ['.crumbs-back', '.library-navigation', '#sources-search-toggle', '#source-search-field'].map(selector => {
        const s = getComputedStyle(tools.querySelector(selector));
        return { background: s.backgroundColor, filter: s.backdropFilter || s.webkitBackdropFilter };
      }));
    assert.ok(materials.every(material => material.background === materials[0].background && material.filter === 'none'), 'navigation controls share a light fill without a second blur layer');
    assert.equal(await page.locator('.crumbs-back').evaluate(el => getComputedStyle(el).opacity), '1', 'disabled back keeps the glass surface visible');
    for (const selector of ['.crumbs-back', '#sources-search-toggle']) {
      assert.deepEqual(await page.locator(selector).evaluate(el => {
        const s = getComputedStyle(el);
        return { clip: s.backgroundClip, padding: s.padding };
      }), { clip: 'border-box', padding: '0px' }, `${selector} paints its entire surface, including nested navigation controls`);
    }
    assert.equal(await page.locator('#source-tools').evaluate(el => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter), 'blur(6px)', 'the full toolbar retains its glass backplate');
    assert.notEqual(await page.locator('#source-tools').evaluate(el => getComputedStyle(el).backgroundColor), materials[0].background, 'the continuous glass backplate and light button fills remain distinct');
    const navigation = await page.locator('#library-navigation').boundingBox();
    const tools = await page.locator('#source-tools').boundingBox();
    const list = await page.locator('#source-list').boundingBox();
    const searchButton = await page.locator('#sources-search-toggle').boundingBox();
    const searchIcon = await page.locator('#sources-search-toggle .icon').boundingBox();
    await page.locator('#sources-search-toggle').click();
    await page.waitForTimeout(60);
    assert.deepEqual(await page.locator('#sources-search-toggle').boundingBox(), searchButton, 'one persistent button stays in place during expansion');
    const opacity = await page.locator('#source-tools').evaluate(tools => ['.source-navigation-rail', '#source-search-field'].map(selector => getComputedStyle(tools.querySelector(selector)).opacity));
    assert.deepEqual(opacity, ['1', '1'], 'navigation and search wipe at full opacity without crossfading');
    await page.waitForTimeout(280);
    const search = await page.locator('#source-search-field').boundingBox();
    assert.ok(search.x <= navigation.x && search.x + search.width >= navigation.x + navigation.width);
    assert.deepEqual(await page.locator('#source-tools').boundingBox(), tools);
    assert.deepEqual(await page.locator('#source-list').boundingBox(), list);
    assert.equal(await page.locator('.source-navigation-rail').evaluate(el => el.inert), true);
    assert.deepEqual(await page.locator('#sources-search-toggle .icon').boundingBox(), searchIcon, 'search and close icons have identical geometry');
    assert.equal(await page.locator('#sources-search-toggle').getAttribute('aria-label'), '关闭搜索');
    assert.equal(await page.locator('#source-search').evaluate(el => document.activeElement === el), true);
    await page.locator('#source-search').fill('sample');
    await page.screenshot({ path: path.join(screenshots, 'source-search-overlay.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#source-search').inputValue(), '');
    assert.equal(await page.locator('#source-search-field').evaluate(el => el.inert), true);
    assert.equal(await page.locator('#sources-search-toggle').evaluate(el => document.activeElement === el), true);
    assert.deepEqual(await page.locator('#library-navigation').boundingBox(), navigation);
    await page.waitForTimeout(280);
    await page.locator('#sources-search-toggle').click();
    await page.locator('#source-search').fill('sample');
    await page.locator('#sources-search-toggle').click();
    assert.equal(await page.locator('#source-search').inputValue(), '');
    assert.equal(await page.locator('#sources-search-toggle').getAttribute('aria-label'), '搜索片源');
  }, { viewport: { width: 581, height: 664 }, reducedMotion: 'no-preference' });

  await check('recent list resizes symmetrically, preserves rows/scroll and remembers its width', async page => {
    await page.addInitScript(() => localStorage.setItem('voidplayer.sources.v1', JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ name: `recent-${i}.mp4`, size: 1000, lastModified: 1000 + i })))));
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    const panel = page.locator('#start-panel'), list = page.locator('#start-library-list');
    const left = page.locator('#start-resize-left'), right = page.locator('#start-resize-right');
    await page.waitForFunction(() => document.querySelectorAll('.start-recent-row').length === 40);
    await checkScrollBoundary(page, '#start-library-list');
    const rail = page.locator('#start-scrollbar'), thumb = page.locator('#start-scrollbar-thumb');
    await rail.waitFor({ state: 'visible' });
    const listBox = await list.boundingBox(), railBox = await rail.boundingBox();
    assert.ok(Math.abs(railBox.y - listBox.y) < 1 && Math.abs(railBox.height - listBox.height) < 1, 'recent scrollbar stays inside the list, below the header and above the footer');
    assert.equal(await list.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none', 'recent list hides the native scrollbar');
    const arrow = await list.locator('.start-recent-go').first().boundingBox();
    assert.ok(arrow.x + arrow.width <= railBox.x - 8, 'recent arrows leave a clear gap before the custom scrollbar');
    await thumb.hover();
    let handle = await thumb.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, railBox.y + railBox.height, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => { const el = document.querySelector('#start-library-list'); return el.scrollTop >= el.scrollHeight - el.clientHeight - 1; });
    handle = await thumb.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, railBox.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#start-library-list').scrollTop <= 1);
    await list.locator('.start-recent-row').first().evaluate(el => el.setAttribute('data-resize-proof', 'retained'));
    const scroll = await list.evaluate(el => { el.scrollTop = 240; return el.scrollTop; });
    const initial = await panel.boundingBox(), center = initial.x + initial.width / 2;
    assert.equal(await page.locator('#start-identity').evaluate(el => getComputedStyle(el).transitionDuration), '0.24s, 0.24s', 'identity button uses the shared color transition');
    for (const handle of [left, right]) {
      assert.equal(await handle.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'idle handles stay hidden');
    }
    async function drag(handle, delta) {
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 6 });
      await page.mouse.up(); await settle(page);
      const next = await panel.boundingBox();
      assert.ok(Math.abs(next.x + next.width / 2 - center) < 1, 'both sides retain the original center');
      return next;
    }
    await right.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-resize-right'), '::after').opacity === '1');
    assert.equal(await right.evaluate(el => getComputedStyle(el, '::after').opacity), '1', 'hover illuminates the handle');
    assert.deepEqual(await right.evaluate(el => ['::before', '::after'].map(pseudo => {
      const style = getComputedStyle(el, pseudo); return [style.transitionProperty, style.transitionDuration];
    })), [['opacity', '0.16s'], ['opacity', '0.32s']], 'line fades in faster than the glow without interpolating pointer position');
    assert.equal(await left.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'only the hovered edge illuminates');
    assert.match(await right.evaluate(el => getComputedStyle(el, '::after').maskImage), /linear-gradient/, 'vertical ends fade out');
    assert.match(await right.evaluate(el => getComputedStyle(el, '::after').backgroundImage), /linear-gradient/, 'outer edge fades out');
    const hoverBox = await right.boundingBox();
    for (const y of [100, 300]) {
      await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + y);
      assert.ok(Math.abs(await right.evaluate(el => parseFloat(getComputedStyle(el, '::after').top)) - y) < 1, 'glow follows the pointer height');
    }
    for (const y of [1, hoverBox.height - 1]) {
      await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + y);
      const glow = await right.evaluate(el => {
        const style = getComputedStyle(el, '::after');
        return { center: parseFloat(style.top), height: parseFloat(style.height), inset: parseFloat(style.left) };
      });
      assert.ok(glow.center >= glow.height / 2 && glow.center <= hoverBox.height - glow.height / 2, 'the whole fade stays inside the gutter at the top and bottom');
      assert.equal(glow.inset, 6, 'glow keeps a gap from the list');
    }
    await page.emulateMedia({ colorScheme: 'dark' }); await settle(page);
    for (const [edge, y] of [['top', 1], ['bottom', hoverBox.height - 1]]) {
      await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + y);
      await page.screenshot({ path: path.join(screenshots, `start-panel-resize-${edge}-${browserName}.png`) });
    }
    await page.mouse.move(center, initial.y + 10);
    assert.deepEqual(await right.evaluate(el => ['::before', '::after'].map(pseudo => getComputedStyle(el, pseudo).transitionDuration)), ['0.22s', '0.42s'], 'line fades out first and the glow lingers');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-resize-right'), '::after').opacity === '0');
    assert.equal(await right.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'leaving fades the glow away');
    await right.focus();
    assert.equal(await right.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'focus cannot leave the glow visible');
    await right.click(); await page.mouse.move(center, initial.y + 10);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-resize-right'), '::after').opacity === '0');
    assert.equal(await right.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'clicking then leaving keeps the handle hidden');
    assert.equal(await right.evaluate(el => el.classList.contains('resizing')), false, 'click without dragging clears the drag state');
    assert.ok(Math.abs((await drag(right, 50)).width - initial.width - 100) < 1);
    const resized = await drag(left, 30);
    assert.ok(Math.abs(resized.width - initial.width - 40) < 1, 'left edge moves in the mirrored direction');
    assert.equal(await list.evaluate(el => el.scrollTop), scroll);
    assert.equal(await list.locator('.start-recent-row').first().getAttribute('data-resize-proof'), 'retained', 'resizing does not rebuild recent rows');
    assert.equal(await left.getAttribute('aria-valuenow'), await right.getAttribute('aria-valuenow'));
    await page.mouse.move(center, initial.y + 10);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-resize-left'), '::after').opacity === '0');
    assert.equal(await left.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'dragging then leaving hides the handle too');
    const box = await right.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
    await right.press('Escape'); await page.mouse.up();
    assert.ok(Math.abs((await panel.boundingBox()).width - resized.width) < 1, 'Escape restores the pre-drag width');
    assert.equal(await panel.evaluate(el => el.classList.contains('resizing')), false);
    await left.dblclick(); assert.ok(Math.abs((await panel.boundingBox()).width - initial.width) < 1, 'double-click restores the default');
    await right.press('ArrowRight'); const preferred = (await panel.boundingBox()).width;
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    assert.ok(Math.abs((await panel.boundingBox()).width - preferred) < 1, 'reload preserves the preference');
    await page.setViewportSize({ width: 390, height: 700 }); await settle(page);
    const small = await panel.boundingBox(), host = await page.locator('#empty-A').boundingBox();
    assert.ok(small.width <= host.width - 48 && Math.abs(small.x + small.width / 2 - host.x - host.width / 2) < 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'compact layout does not overflow');
    await page.setViewportSize({ width: 1280, height: 800 }); await settle(page);
    assert.ok(Math.abs((await panel.boundingBox()).width - preferred) < 1, 'expanding the window restores the preference');
    await page.locator('#toggle-sources').click();
    await page.waitForFunction(() => !document.querySelector('#workspace').classList.contains('panel-motion')); await settle(page);
    await page.waitForFunction(() => {
      const panel = document.querySelector('#start-panel').getBoundingClientRect(), host = document.querySelector('#empty-A').getBoundingClientRect();
      return panel.width <= host.width - 48 && Math.abs(panel.x + panel.width / 2 - host.x - host.width / 2) < 1;
    });
    const { shifted, remaining } = await page.evaluate(() => ({ shifted: document.querySelector('#start-panel').getBoundingClientRect().toJSON(), remaining: document.querySelector('#empty-A').getBoundingClientRect().toJSON() }));
    assert.ok(shifted.width <= remaining.width - 48 && Math.abs(shifted.x + shifted.width / 2 - remaining.x - remaining.width / 2) < 1, `sidebar layout keeps the list centered and bounded: ${JSON.stringify({ shifted, remaining })}`);
    await page.locator('#toggle-sources').click();
    await page.waitForFunction(() => !document.querySelector('#workspace').classList.contains('panel-motion'));
    await page.waitForFunction(width => Math.abs(document.querySelector('#start-panel').getBoundingClientRect().width - width) < 1, preferred);
    await settle(page); await right.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-resize-right'), '::after').opacity === '1');
    await page.screenshot({ path: path.join(screenshots, `start-panel-resize-${browserName}.png`) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await right.evaluate(el => ['::before', '::after'].map(pseudo => getComputedStyle(el, pseudo).transitionDuration)), ['0s', '0s'], 'reduced motion disables both fades');
    await page.mouse.move(center, initial.y + 10);
    assert.equal(await right.evaluate(el => getComputedStyle(el, '::after').opacity), '0', 'reduced motion hides the glow immediately');
  }, { reducedMotion: 'no-preference' });

  await check('brand cinema waits for a stationary hover and restores quickly', async page => {
    const brand = page.locator('#brand-about'), cinema = page.locator('body > .brand-cinema');
    const chunks = [];
    page.on('request', request => { if (/brand-cinema.*\.(js|css)/.test(request.url())) chunks.push(request.url()); });
    await page.waitForTimeout(1300);
    await brand.focus();
    assert.equal(await cinema.count(), 0, 'idle and keyboard focus must stay still');
    assert.equal(chunks.length, 0, 'cinematic JS and CSS stay off the startup path');
    await brand.hover();
    await page.waitForTimeout(450);
    await page.mouse.move(400, 90);
    await page.waitForTimeout(800);
    assert.equal(await cinema.count(), 0, 'a passing hover does not start an animation');
    assert.equal(chunks.length, 0, 'a passing hover does not download the chunk');
    const box = await brand.boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.waitForTimeout(650);
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
    await page.waitForTimeout(650);
    assert.equal(await cinema.count(), 0, 'movement inside the title resets the dwell');
    await cinema.waitFor();
    assert.equal(await cinema.evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.equal(await cinema.getAttribute('aria-hidden'), 'true');
    assert.equal(await brand.evaluate(el => getComputedStyle(el).opacity), '0');
    assert.ok(chunks.some(url => url.endsWith('.js')) && chunks.some(url => url.endsWith('.css')), 'both chunks load on demand');
    await page.mouse.move(400, 90);
    await cinema.waitFor({ state: 'detached', timeout: 700 });
    assert.equal(await brand.evaluate(el => getComputedStyle(el).opacity), '1');
    await brand.hover(); await cinema.waitFor();
    await page.keyboard.press('Escape');
    await cinema.waitFor({ state: 'detached', timeout: 700 });
    await page.waitForTimeout(1300);
    assert.equal(await cinema.count(), 0, 'Escape does not immediately replay while still hovering');
    await brand.click();
    assert.equal(await page.locator('#settings-pane-about').isVisible(), true, 'click opens About directly');
    assert.equal(await cinema.count(), 0);
  }, { reducedMotion: 'no-preference' });

  await check('brand animation honors reduced motion and keeps About usable', async page => {
    await page.locator('#brand-about').hover();
    await page.waitForTimeout(1300);
    assert.equal(await page.locator('.brand-cinema').count(), 0);
    await page.locator('#brand-about').click();
    assert.equal(await page.locator('#settings-pane-about').isVisible(), true);
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

  await check('track filenames show basenames with full paths in shared tooltips', async page => {
    const fullName = 'review/shots/path-tooltip.mp4';
    const entry = listing.entries.find(item => item.name === fullName);
    assert.ok(entry, 'nested library fixture exists');
    await page.evaluate(async id => window.voidPlayer.tools.find(tool => tool.name === 'load_library_item').execute({ id, slot: 'A' }), entry.id);
    await panels(page, true);
    const controls = ['[data-inspect="A"]', '[data-track-drag="A"] .subtrack-name', '#track-selector .track-choice'];
    for (const selector of controls) {
      const control = page.locator(selector);
      assert.equal(await control.locator('.filename').textContent(), 'path-tooltip.mp4');
      assert.equal(await control.getAttribute('data-tooltip'), fullName);
      assert.equal(await control.getAttribute('title'), null, 'no native tooltip');
      await control.hover();
      await page.waitForFunction(name => !document.querySelector('#control-tooltip').hidden && document.querySelector('#control-tooltip').textContent === name, fullName);
      assert.equal(await page.locator('#control-tooltip').textContent(), fullName);
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => document.querySelector('#control-tooltip').hidden);
    }
    await page.locator('#settings-open').click();
    await page.locator('#settings-tab-appearance').click();
    await page.locator('#language-choice').click();
    await page.locator('#language-choice-menu [data-value=en]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.locator('#settings-close').click();
    for (const selector of controls) assert.equal(await page.locator(selector).getAttribute('data-tooltip'), fullName, 'language changes preserve path tooltip');
    assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks[0].name, fullName, 'original source path is retained');
    await page.locator('[data-inspect="A"]').hover();
    await page.waitForFunction(() => !document.querySelector('#control-tooltip').hidden);
    await page.screenshot({ path: path.join(screenshots, `${browserName}-track-path-tooltip.png`) });
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
    assert.equal(await page.locator('.color-flow-footnote').count(), 0, 'removed color-flow footnote stays absent');
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

  await check('toast entrance animates and respects reduced motion', async page => {
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(() => {
      window.toastFrames=[];
      const observe=new MutationObserver(records=>{
        const toast=records.flatMap(record=>[...record.addedNodes]).find(node=>node instanceof HTMLElement && node.classList.contains('toast-warning'));
        if(!toast)return;
        observe.disconnect();
        const sample=()=>{
          window.toastFrames.push({opacity:+getComputedStyle(toast).opacity, animations:toast.getAnimations().map(animation=>animation.animationName)});
          if(window.toastFrames.length<20)requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      observe.observe(document.body,{subtree:true,childList:true});
      void window.voidPlayer.loadFile('A',new File(['invalid'],'animated-toast.flv')).catch(()=>{});
    });
    await page.waitForFunction(()=>window.toastFrames.length===20);
    const frames=await page.evaluate(()=>window.toastFrames);
    assert.ok(frames.some(frame=>frame.animations.includes('toast-appear') && frame.opacity>0 && frame.opacity<1),'entrance paints intermediate opacity');
    assert.equal(frames.at(-1).opacity,1);
    const warning=page.locator('.toast-warning');
    assert.equal(await warning.evaluate(el=>el.classList.contains('toast-enter')),false,'finished entrance cleans its animation class');
    await warning.locator('.toast-close').click(); await warning.waitFor({state:'detached'});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>window.voidPlayer.loadFile('A',new File(['invalid'],'reduced-toast.flv')).catch(()=>{}));
    await warning.waitFor({state:'visible'});
    assert.deepEqual(await warning.evaluate(el=>({opacity:getComputedStyle(el).opacity,animations:el.getAnimations().length,enter:el.classList.contains('toast-enter')})),{opacity:'1',animations:0,enter:false});
  });

  await check('analysis pause and repeated resume do not emit warning toasts', async page => {
    const media=listing.entries.find(entry=>entry.name==='ci_h264_smoke.mp4');
    await page.evaluate(id=>window.voidPlayer.tools.find(tool=>tool.name==='load_library_item').execute({id,slot:'A'}),media.id);
    let release; const gate=new Promise(resolve=>{release=resolve;});
    const pattern='**/api/bitstream-analysis/requests/*';
    await page.route(pattern,async route=>{
      if(route.request().method()==='GET')await gate;
      await route.continue().catch(()=>{});
    });
    try {
      await page.evaluate(()=>{
        window.pauseWarnings=[];
        new MutationObserver(records=>{
          for(const node of records.flatMap(record=>[...record.addedNodes]))if(node instanceof HTMLElement && node.classList.contains('toast-warning'))window.pauseWarnings.push(node.textContent);
        }).observe(document.body,{subtree:true,childList:true});
      });
      await page.locator('#toggle-analysis').click();
      await page.locator('#analysis-diagrams [data-value=nalu-size]').click();
      const action=page.locator('#analysis-status-items .analysis-progress-action[data-slot=A]');
      for(let cycle=0;cycle<3;cycle++) {
        await page.waitForFunction(()=>window.voidPlayer.tools.find(tool=>tool.name==='get_bitstream_analysis_state').execute({slot:'A'}).state==='pending');
        await action.click();
        await page.waitForFunction(()=>window.voidPlayer.tools.find(tool=>tool.name==='get_bitstream_analysis_state').execute({slot:'A'}).state==='paused');
        await settle(page);
        assert.deepEqual(await page.evaluate(()=>window.pauseWarnings),[],'intentional cancellation never flashes a warning');
        if(cycle<2)await action.click();
      }
      assert.equal(await page.locator('.toast-warning').count(),0);
      await page.screenshot({path:path.join(screenshots,`${browserName}-analysis-pause-without-warning.png`)});
    } finally {release(); await page.unroute(pattern);}
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

  await check('HLG Dolby sample uses managed SDR preview and preserves browser compatibility', async page => {
    const id = listing.entries.find(item => item.name === 'dolby_hlg_1080p30.mp4').id;
    const managed = await page.evaluate(async id => {
      const tool = name => window.voidPlayer.tools.find(t => t.name === name);
      await tool('set_review_color_mode').execute({ mode: 'reference' });
      await tool('set_reference_decode').execute({decoder:'software',depth:2});
      await tool('load_library_item').execute({ id, slot: 'A' });
      return window.voidPlayer.getState();
    }, id);
    assert.equal(managed.error,null);assert.ok(!managed.tracks[0].failure);
    assert.equal(managed.tracks[0].output.color.transfer,'hlg');assert.ok(managed.tracks[0].output.yuv.bitDepth>=10);
    assert.equal(managed.tracks[0].presentation.actualTarget,'sdr');
    assert.equal(await page.locator('.toast-warning').count(),0);
    await page.locator('#settings-open').click();await page.locator('#settings-tab-performance').click();
    await page.locator('[data-color-mode=browser]').click();
    await page.waitForFunction(() => { const state = window.voidPlayer.getState(); return state.colorMode === 'browser' && !state.busy; });
    await page.locator('#settings-close').click();
    await page.evaluate(async id => window.voidPlayer.tools.find(t => t.name === 'load_library_item').execute({ id, slot: 'A' }), id);
    await page.locator('#play').click();
    // A virtual runner can use CPU HDR conversion without WebGL/WebGPU.
    // This checks eventual UI playback; the separate benchmarks check speed.
    try {
      await page.waitForFunction(() => {
        const state = window.voidPlayer.getState();
        return state.positionUs > 500000 || state.error !== null;
      }, undefined, { timeout: 60000 });
    } catch (error) {
      console.error('HLG browser playback stalled', await page.evaluate(() => ({
        state: window.voidPlayer.getState(),
        canvases: [...document.querySelectorAll('canvas[data-color-executor]')].map(c => ({ executor: c.dataset.colorExecutor, performance: c.dataset.colorPerformance })),
      })));
      throw error;
    }
    await page.locator('#play').click();
    const state = await page.evaluate(() => window.voidPlayer.getState());
    assert.ok(state.positionUs > 500000, 'HLG browser playback advances through real frames');
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
    const activityA=page.locator('#source-activity-track-A'), activityB=page.locator('#source-activity-track-B');
    assert.equal(await activityB.getAttribute('aria-selected'),'true','new loads initially reveal their own details');
    assert.equal(await page.locator('#source-activity-details').isVisible(),false,'presentation details default to collapsed');
    await page.locator('#source-activity-toggle').click();
    await activityA.click();
    assert.equal(await page.locator('#source-activity-name').textContent(),'ci_h264_smoke.mp4');
    assert.equal(await page.locator('#source-activity-stage').textContent(),'已上屏');
    assert.match(await page.locator('#source-activity-size').textContent(),/320×180/);
    assert.equal(await page.locator('#source-activity-time').isVisible(),true,'earlier tracks retain their own load timing');
    await activityA.press('ArrowRight');
    assert.equal(await activityB.getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#source-activity-name').textContent(),'h264_9s_1920x1080.mp4');
    assert.match(await page.locator('#source-activity-size').textContent(),/1920×1080/);
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
    // B is smaller in uniform-pixel mode. The wipe can hide it completely
    // without either image leaving the stage, even with a small shared pan.
    await page.evaluate(() => window.voidPlayer.setViewport({ zoom: 1.25, offsetX: 80, offsetY: 15, splitPos: .5 }));
    await settle(page);
    const stageBox = await page.locator('#stage-A').boundingBox();
    const dividerBox = await page.locator('#divider').boundingBox();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
    await page.mouse.down();
    for (const cut of [.05, .1, .2, .5, .8, .9, .95, 1, 0, .5]) {
      await page.mouse.move(stageBox.x + stageBox.width * cut, dividerBox.y + dividerBox.height / 2, { steps: 3 });
      await settle(page);
      assert.equal(await page.locator('.recover-view:visible').count(), 0, `wipe at ${cut} does not trigger pan recovery`);
    }
    await page.mouse.up();
    await page.evaluate(() => window.voidPlayer.setViewport({ zoom: 1.25, offsetX: 2000, offsetY: 0, splitPos: .5 }));
    await settle(page);
    assert.equal(await page.locator('#recover-B').isVisible(), true, 'real pan beyond the whole stage still offers recovery');
    await page.locator('#recover-B').click(); await settle(page);
    assert.equal(await page.evaluate(() => window.voidPlayer.getViewport().zoom), 1.25, 'recovery retains zoom');
    assert.equal(await page.locator('#recover-B').isVisible(), false, 'recovery brings the image back into view');
    await page.evaluate(() => window.voidPlayer.setViewport({ offsetX: 80, offsetY: 15, splitPos: .95 }));
    await settle(page);
    await page.locator('.viewport-surface').screenshot({ path: path.join(screenshots, `${browserName}-split-wipe-recovery.png`) });
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
    await page.evaluate(() => window.voidPlayer.setViewport({ offsetX: 1200, offsetY: -500 }));
    await settle(page);
    assert.equal(await page.locator('#recover-A').isVisible(), true);
    const wheelStage = await page.locator('#stage-A').boundingBox();
    await page.mouse.move(wheelStage.x + wheelStage.width / 2, wheelStage.y + wheelStage.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => { const view = window.voidPlayer.getViewport(); return view.zoom === 1 && view.offsetX === 0 && view.offsetY === 0; });
    assert.equal(await page.locator('#recover-A').isVisible(), false, 'zooming out at 1x restores a panned-away image');
    await page.evaluate(() => window.voidPlayer.setViewport({ offsetX: -1200, offsetY: 500 }));
    await page.locator('#stage-A').dispatchEvent('wheel', { deltaY: 8.5, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true });
    await settle(page);
    const pinchView = await page.evaluate(() => window.voidPlayer.getViewport());
    assert.deepEqual([pinchView.zoom, pinchView.offsetX, pinchView.offsetY], [1, 0, 0], 'pinching to zoom out also recenters at the minimum zoom');
    const beforeFocus = await page.locator('#stage-A').boundingBox();
    const focusButton = await page.locator('#toggle-chrome').boundingBox();
    assert.equal(await page.locator('#toggle-chrome').getAttribute('data-tooltip'), '专注模式 (F)');
    await page.locator('#toggle-chrome').click(); await settle(page);
    assert.equal(await page.locator('.transport').evaluate(el => el.inert), true);
    assert.deepEqual(await page.locator('#stage-A').boundingBox(), beforeFocus);
    assert.deepEqual(await page.locator('#toggle-chrome').boundingBox(), focusButton, 'focus toggle stays in place');
    assert.equal(await page.locator('#toggle-chrome').getAttribute('data-tooltip'), '专注模式 (F)');
    await page.locator('#toggle-chrome').click();
    await page.locator('#toggle-annotations').click();
    assert.equal(await page.locator('#toggle-annotations').getAttribute('aria-expanded'),'true');
    await page.locator('#annotation-toolbar').waitFor({state:'visible'});
    await page.locator('#toggle-analysis-overlay').click();
    await page.locator('#analysis-overlay-panel').waitFor({state:'visible'});
    await page.locator('#toggle-annotations').click();
    assert.equal(await page.locator('#toggle-annotations').getAttribute('aria-expanded'),'false');
    assert.ok(await page.locator('#analysis-overlay-panel').isVisible(),'annotation activation does not close overlay controls');
    await page.locator('#toggle-analysis-overlay').click();
    for(const [width,time,stepping] of [[800,true,true],[500,false,true],[300,false,false],[220,false,false]]) {
      await page.setViewportSize({width,height:800});await settle(page);
      assert.equal(await page.locator('.transport-time').isVisible(),time,'time editing gives way first');
      for(const id of ['previous','next'])assert.equal(await page.locator(`#${id}`).isVisible(),stepping,'frame stepping gives way second');
      const boxes=[];
      for(const id of ['play','timeline','toggle-annotations','toggle-analysis-overlay','fullscreen','toggle-chrome']) {
        assert.ok(await page.locator(`#${id}`).isVisible(),`${id} remains visible at ${width}px`);
        boxes.push(await page.locator(`#${id}`).boundingBox());
      }
      const bounds=await page.locator('.transport-dock').boundingBox();
      for(let i=0;i<boxes.length;i++) {
        const box=boxes[i];assert.ok(box.x>=bounds.x && box.x+box.width<=bounds.x+bounds.width+.1,'control remains inside the bar');
        assert.ok(Math.abs(box.y+box.height/2-(bounds.y+bounds.height/2))<1,'controls align in one row');
        if(i)assert.ok(box.x>=boxes[i-1].x+boxes[i-1].width-.1,'transport controls never overlap');
      }
      for(const box of boxes.slice(2))assert.equal(box.width,28,'viewport tool buttons never shrink');
      await page.locator('#toggle-chrome').click();await settle(page);
      assert.deepEqual(await page.locator('#toggle-chrome').boundingBox(),boxes.at(-1),'focus escape stays in the same row position');
      await page.locator('#toggle-chrome').click();
    }
    await page.setViewportSize({width:1280,height:800});await settle(page);
    await page.locator('#remove-track-B').click();
    await page.waitForFunction(() => !window.voidPlayer.getState().tracks.some(track => track.slot === 'B'));
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.dragSurface), 'A');
    for (const slot of ['C', 'D', 'E', 'F', 'G', 'H', 'A']) await page.locator(`#remove-track-${slot}`).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'open');
  });

  await check('analysis recovery preserves coverage and retries through production controls', async page => {
    const media = listing.entries.find(entry => entry.name === 'ci_h264_smoke.mp4');
    await page.evaluate(id => window.voidPlayer.tools.find(tool => tool.name === 'load_library_item').execute({id,slot:'A'}), media.id);
    await page.locator('#toggle-analysis').click();
    await page.locator('#analysis-status-items').waitFor();
    const sheets=await page.locator('link[rel=stylesheet]').evaluateAll(nodes=>nodes.map(node=>node.href));
    const markup=await page.locator('body').innerHTML();
    const entry=path.join(temporary,'analysis-recovery.ts');
    await writeFile(entry, `export {ReviewSession} from ${JSON.stringify(path.join(root,'src/session.ts'))};
      export {BitstreamAnalysisService} from ${JSON.stringify(path.join(root,'src/bitstream-analysis/service.ts'))};
      export {AnalysisFailure} from ${JSON.stringify(path.join(root,'src/bitstream-analysis/failure.ts'))};
      export {installBitstreamControls} from ${JSON.stringify(path.join(root,'src/ui/bitstream-controls.ts'))};
      export {installAnalysisPanel} from ${JSON.stringify(path.join(root,'src/ui/analysis-panel.ts'))};
      export {rgbaDescription} from ${JSON.stringify(path.join(root,'src/frame-description.ts'))};
      export {packLegacy,summaryOf} from ${JSON.stringify(path.join(root,'src/bitstream-analysis/products.ts'))};`);
    const fixture=await buildFixture({configFile:false,logLevel:'silent',build:{write:false,minify:false,
      lib:{entry,formats:['iife'],name:'RecoveryFixture'},rolldownOptions:{output:{codeSplitting:false}}}});
    const script=[fixture].flat().flatMap(output=>output.output).find(output=>output.type==='chunk').code;
    await page.route('**/recovery-fixture',route=>route.fulfill({contentType:'text/html',body:
      `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">${sheets.map(href=>`<link rel="stylesheet" href="${href}">`).join('')}</head><body>${markup}</body></html>`}));
    await page.goto(`${base}/recovery-fixture`); await page.addScriptTag({content:script});
    await page.evaluate(async()=>{
      const {ReviewSession,BitstreamAnalysisService,AnalysisFailure,installBitstreamControls,installAnalysisPanel,rgbaDescription,packLegacy,summaryOf}=RecoveryFixture;
      const manifest=await fetch(new URL('/vendor/voidplayer-analysis/manifest.json',location.href)).then(r=>r.json()),buildId=manifest.buildId??manifest.revision;
      const sourceVersion='recovery-source';
      window.recovery={streams:0,pictures:0,failure:'error',commit:0};
      const result=au=>({schema:1,codec:'h264',analyzerVersion:'0.1.0',buildId,recipe:'blocks-basic-v2',
        picture:{sourceVersion,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'},sourcePtsUs:100+au*100,
        width:16,height:16,confidence:'exact',reasons:[],capabilities:{blocks:'ready',qp:'ready',modes:'ready',motion:'unsupported'},
        qp:{component:'luma',bitDepth:8,weighting:'pixel-area',mean:23},blocks:[{x:0,y:0,width:16,height:16,qp:23,mode:'intra'}],
        metrics:{startAu:0,packets:au+1,bytesRead:100,elapsedMs:1,recordBytes:12,heapBytes:67108864},gop:{startAu:0,endAu:3,configuration:0,anchor:'closed'}});
      const fail=()=>{if(recovery.failure==='error')throw Error('Temporary network error');if(recovery.failure==='unsupported')throw new AnalysisFailure('unsupported-codec','Unsupported codec');};
      BitstreamAnalysisService.prototype.localRange=async function(_file,_target,_signal,consume,progress){
        recovery.streams++; (recovery.windows??=[]).push(_target.window); fail();
        if(recovery.hold)await new Promise((resolve,reject)=>{recovery.release=resolve;_signal.addEventListener('abort',()=>reject(_signal.reason),{once:true});});
        progress({pictures:0,totalPictures:3,checkedUs:0,totalUs:300,indexComplete:true});
        for(let au=0;au<3;au++){const r=result(au),hit=_target.product==='summary'?this.diagrams.getSummary(r.picture,buildId,_target.indexIdentity??null):_target.product==='blocks'?this.cache.getProduct(r.picture,buildId,_target.indexIdentity??null):this.cache.getMatching(r.picture,buildId,_target.indexIdentity??null);consume(hit??(_target.product==='summary'?summaryOf(r,_target.indexIdentity??null):_target.product==='blocks'?packLegacy(r,_target.indexIdentity??null):r),!!hit);}
      };
      BitstreamAnalysisService.prototype.local=async function(_file,target){recovery.pictures++;(recovery.targets??=[]).push(target.picture.au);fail();return packLegacy(result(target.picture.au),target.indexIdentity??null);};
      const session=new ReviewSession((_slot,frame)=>{frame.presentedCommit=++recovery.commit;});
      recovery.session=session;
      // Exercise production lazy construction; only backend methods are mocked.
      // Cache eviction below follows the coordinator's read-only query owner.
      Object.defineProperty(recovery,'root',{get:()=>session.bitstream.queries});
      if(session.getBitstreamAnalysisState('A').state!=='idle'||recovery.root!==undefined)throw Error('Recovery fixture must begin with the real idle coordinator');
      document.getElementById('analysis-range-editor')?.remove();
      document.getElementById('analysis-panel').replaceChildren();document.getElementById('analysis-panel').hidden=false;
      const life=new AbortController();
      const chart=installAnalysisPanel(session,async run=>{await run();},{signal:life.signal,isOpen:()=>false,selectedSlot:()=> 'A'}); recovery.chart=chart;
      const canvases=Object.fromEntries(['A','B','C','D','E','F','G','H'].map(slot=>[slot,document.getElementById(`canvas-${slot}`)]));
      const overlay=installBitstreamControls(session,canvases,{selected:()=> 'A'});
      const offOverlay=session.subscribe(()=>overlay.render(session.getState()));
      recovery.dispose=async()=>{offOverlay();life.abort();overlay.dispose();await session.dispose();};
      const source={info:{id:sourceVersion,name:'recovery.mp4',container:'isobmff',size:1,lastModified:0,codec:'h264',decoder:'webcodecs',width:16,height:16,firstPtsUs:100,durationUs:30_000_000},bitstreamFile:new Blob(['fixture']),
        async frameAt(time){const au=Math.min(2,Math.floor(time/100));return {kind:'video-sample',ptsUs:au*100,sourcePtsUs:100+au*100,durationUs:100,description:rgbaDescription(16,16),width:16,height:16,byteSize:1024,sourcePicture:result(au).picture,close(){}};},
        async framesAfter(){return[];},async *framesFrom(){},dispose(){}};
      await session.load('A',async()=>source);
      if(session.getBitstreamAnalysisState('A').state!=='idle'||recovery.root!==undefined)throw Error('Loading must preserve lazy analysis ownership');
      chart.setOpen(true);overlay.setOpen(true);
    });
    await page.locator('#bitstream-retry-A').waitFor({state:'visible'});
    await page.locator('#analysis-retry-A').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>recovery.streams),0,'opening the overlay never starts a stream');
    assert.equal(await page.evaluate(()=>recovery.pictures),1,'failed current picture is automatically attempted once');
    await page.locator('#bitstream-close').click();await page.locator('#toggle-analysis-overlay').click();
    assert.equal(await page.evaluate(()=>recovery.pictures),1,'closing and reopening does not loop failed requests');
    await page.screenshot({path:path.join(screenshots,`${browserName}-analysis-retry.png`)});
    await page.evaluate(()=>{recovery.failure='';});
    await page.locator('#bitstream-retry-A').click();
    await page.waitForFunction(()=>recovery.session.cachedBitstreamAnalysis('A')?.picture.au===0 && recovery.session.getBitstreamAnalysisState('A').state==='ready');
    assert.equal(await page.evaluate(()=>recovery.pictures),2,'overlay retry recovers the current picture before any full scan');
    assert.equal(await page.evaluate(()=>recovery.streams),0,'overlay retry also avoids whole-stream analysis');
    await page.evaluate(async()=>{recovery.failure='error';await recovery.session.requestBitstreamStream('A').catch(()=>{});});
    await page.locator('#analysis-retry-A').waitFor({state:'visible'});
    await page.evaluate(()=>{recovery.failure='';});
    await page.locator('#analysis-retry-A').click();
    await page.waitForFunction(()=>recovery.session.getBitstreamAnalysisState('A').state==='ready' && recovery.session.getBitstreamAnalysisState('A').stream?.pictures===3);
    assert.equal(await page.evaluate(()=>recovery.streams),2,'chart retry explicitly restarts the visible region');
    assert.deepEqual(await page.evaluate(()=>recovery.windows.at(-1)), {startUs:0,endUs:10_000_000,axis:'pts'});
    assert.equal(await page.evaluate(()=>recovery.session.getBitstreamAnalysisState('A').completedStream),undefined,'visible coverage is not whole-source completion');
    assert.equal(await page.locator('#analysis-retry-A').isVisible(),false);
    for(const time of [100,200]){
      await page.evaluate(async time=>{recovery.root.cache.clear();await recovery.session.seek(time);},time);
      await page.waitForFunction(au=>recovery.session.cachedBitstreamAnalysis('A')?.picture.au===au,time/100);
    }
    assert.deepEqual(await page.evaluate(()=>recovery.targets),[0,0,1,2],'initial inspection, retry and newly presented missing frames are requested');
    assert.equal(await page.evaluate(()=>recovery.pictures),4,'both evicted frames are automatically replenished');
    assert.equal(await page.evaluate(()=>recovery.streams),2,'picture replenishment does not restart whole-stream analysis');
    await page.evaluate(async()=>{recovery.failure='error';recovery.root.cache.clear();await recovery.session.seek(0);});
    await page.locator('#bitstream-retry-A').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>recovery.session.getBitstreamAnalysisState('A').completedStream),undefined);
    await page.evaluate(()=>{recovery.failure='';});await page.locator('#bitstream-retry-A').click();
    await page.waitForFunction(()=>recovery.session.cachedBitstreamAnalysis('A')?.picture.au===0 && recovery.session.getBitstreamAnalysisState('A').state==='ready');
    assert.equal(await page.evaluate(()=>recovery.pictures),6,'overlay retry recovers the failed picture');
    await page.evaluate(async()=>{recovery.failure='unsupported';await recovery.session.requestBitstreamStream('A').catch(()=>{});});
    assert.equal(await page.locator('#analysis-retry-A').isVisible(),false);
    assert.equal(await page.locator('#bitstream-retry-A').isVisible(),false);
    const attempts=await page.evaluate(()=>recovery.streams);
    await page.locator('#bitstream-close').click();await page.locator('#toggle-analysis-overlay').click();await settle(page);
    assert.equal(await page.evaluate(()=>recovery.streams),attempts,'unsupported capability is never retried automatically');
    await page.locator('#analysis-range-trigger').click();
    await page.waitForFunction(()=>document.querySelector('#analysis-range-editor').matches(':popover-open'));
    const handles=page.locator('.analysis-window-handle');
    assert.equal(await handles.count(),2);
    assert.equal(await handles.nth(1).getAttribute('aria-valuenow'),'10000000','fresh view shows the first ten seconds');
    await page.evaluate(()=>{const saved=recovery.chart.getAnalysisState();recovery.chart.restoreAnalysisState({...saved,view:{start:15_000_000,end:20_000_000}});});
    await page.waitForFunction(()=>document.querySelector('[data-edge=end]')?.getAttribute('aria-valuenow')==='20000000');
    await handles.nth(1).press('ArrowLeft');
    await page.waitForFunction(()=>document.querySelector('[data-edge=end]')?.getAttribute('aria-valuenow')==='19900000');
    const pointer=await handles.nth(1).boundingBox();
    await page.mouse.move(pointer.x+pointer.width/2,pointer.y+pointer.height/2);
    await page.mouse.down(); await page.mouse.move(pointer.x-20,pointer.y+pointer.height/2); await page.mouse.up();
    await page.waitForFunction(()=>+document.querySelector('[data-edge=end]').getAttribute('aria-valuenow')<19900000);
    await page.evaluate(()=>{const saved=recovery.chart.getAnalysisState();recovery.chart.restoreAnalysisState({...saved,view:{start:15_000_000,end:19_900_000}});});
    await page.waitForFunction(()=>document.querySelector('[data-edge=end]')?.getAttribute('aria-valuenow')==='19900000');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'range controls add no page width');
    await page.evaluate(()=>{recovery.failure='';recovery.hold=true;recovery.pending=recovery.session.requestBitstreamStream('A',undefined,{startUs:15_000_000,endUs:19_900_000,axis:'pts'}).catch(()=>{});});
    const action=page.locator('#analysis-status-items .analysis-progress-action');
    await action.waitFor({state:'visible'});
    const centers=await action.evaluate(el=>{const b=el.getBoundingClientRect(),ring=el.querySelector('.analysis-track-progress').getBoundingClientRect();return {dx:ring.x+ring.width/2-b.x-b.width/2,dy:ring.y+ring.height/2-b.y-b.height/2};});
    assert.ok(Math.abs(centers.dx)<1 && Math.abs(centers.dy)<1,'progress ring is centered');
    await action.hover();
    assert.equal(await action.getAttribute('aria-label'),'暂停分析轨道 A');
    const pauseGlyph=await action.locator('[data-icon=playback]').innerHTML();
    await action.click();
    await page.waitForFunction(()=>recovery.session.getBitstreamAnalysisState('A').state==='paused');
    assert.equal(await action.getAttribute('aria-label'),'继续分析轨道 A');
    assert.notEqual(await action.locator('[data-icon=playback]').innerHTML(),pauseGlyph,'pause and play reuse the animated playback icon');
    await page.screenshot({path:path.join(screenshots,`${browserName}-analysis-paused-range.png`)});
    await page.evaluate(()=>{recovery.hold=false;});
    await action.click();
    await page.waitForFunction(()=>recovery.session.getBitstreamAnalysisState('A').state==='ready');
    assert.deepEqual(await page.evaluate(()=>recovery.windows.at(-1)),{startUs:15_000_000,endUs:19_900_000,axis:'pts'},'resume uses the restored and edited visible window');
    await page.evaluate(()=>recovery.dispose());
  });

  await check('library file context menu copies exact paths, downloads and follows shared menu behavior', async page => {
    const entry = listing.entries.find(entry => entry.name === 'review/shots/path-tooltip.mp4');
    assert.ok(entry);
    await page.locator('#toggle-sources').click();
    await page.locator('#library-location').fill(`library:${entry.rootId}/review/shots`);
    await page.locator('#library-location').press('Enter');
    const row = page.locator('#source-list .source-row').filter({has:page.locator('.filename', {hasText:'path-tooltip.mp4'})});
    await row.waitFor();
    const menu = page.locator('#library-file-menu');
    assert.equal(await menu.count(), 1, 'one delegated menu serves the whole list');
    const filmIcon = await page.locator('#toggle-sources svg').innerHTML();
    assert.equal(await page.locator('#start-library-more svg').innerHTML(), filmIcon, 'welcome library entry uses the toolbar film icon');
    await page.evaluate(() => {
      window.contextCopies = [];
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
        writeText: async text => {window.contextCopies.push(text);},
        write: async items => {window.contextCopies.push(await (await items[0].getType('text/plain')).text());},
      }});
    });
    await row.click({button:'right'});
    assert.deepEqual(await menu.locator('button').allTextContents(), ['拷贝文件名','拷贝绝对路径','拷贝媒体库路径','下载文件']);
    assert.equal(await menu.locator('[data-action=copy-library-path] svg').innerHTML(), filmIcon, 'library path action uses the same film icon');
    assert.equal(await menu.evaluate(el => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter), 'blur(8px)');
    await page.screenshot({path:path.join(screenshots, `${browserName}-library-context-menu.png`)});
    await page.emulateMedia({colorScheme:'dark'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({path:path.join(screenshots, `${browserName}-library-context-menu-dark.png`), clip:{x:1040,y:40,width:240,height:220}});
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await menu.locator('[data-action=copy-name]').click();
    await page.waitForFunction(() => window.contextCopies.length === 1);
    await row.click({button:'right'});
    await menu.locator('[data-action=copy-library-path]').click();
    await page.waitForFunction(() => window.contextCopies.length === 2);
    await row.click({button:'right'});
    await menu.locator('[data-action=copy-path]').click();
    await page.waitForFunction(() => window.contextCopies.length === 3);
    assert.deepEqual(await page.evaluate(() => window.contextCopies), ['path-tooltip.mp4', `library:${entry.rootId}/review/shots/path-tooltip.mp4`, await realpath(path.join(roots[0], 'review/shots/path-tooltip.mp4'))]);
    assert.equal(await row.evaluate(el => document.activeElement === el), true, 'actions return focus without loading the source');
    assert.equal(await page.evaluate(() => window.voidPlayer.getState().tracks.length), 0);
    await row.press('Shift+F10');
    assert.equal(await menu.evaluate(el => el.matches(':popover-open')), true);
    await page.keyboard.press('End');
    assert.equal(await menu.locator('[data-action=download]').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    assert.equal(await menu.locator('[data-action=download]').evaluate(el => document.activeElement === el), true);
    const downloading = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const download = await downloading;
    assert.equal(download.suggestedFilename(), 'path-tooltip.mp4');
    const url = new URL(download.url());
    assert.equal(url.searchParams.get('v'), entry.version);
    assert.equal(url.searchParams.get('download'), '1');
    await download.delete();
    await row.press('Shift+F10'); await page.keyboard.press('Escape');
    assert.equal(await menu.evaluate(el => el.matches(':popover-open')), false);
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
    await row.click({button:'right'}); await page.locator('#library-location').click();
    assert.equal(await menu.evaluate(el => el.matches(':popover-open')), false, 'outside click dismisses');
    await row.click({button:'right'});
    await page.locator('#source-list').dispatchEvent('scroll');
    assert.equal(await menu.evaluate(el => el.matches(':popover-open')), false, 'list scrolling dismisses');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width,height:800});
      await settle(page);
      await row.dispatchEvent('contextmenu', {clientX:width-2,clientY:798});
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 4 && bounds.y >= 4 && bounds.x + bounds.width <= width - 3 && bounds.y + bounds.height <= 797, 'menu stays inside the viewport');
      await page.keyboard.press('Escape');
    }
    await row.click({button:'right'});
    await page.locator('#library-location').fill('library:/'); await page.locator('#library-location').press('Enter');
    await row.waitFor({state:'detached'});
    assert.equal(await menu.evaluate(el => el.matches(':popover-open')), false, 'replacing rows dismisses stale actions');
  });

  await check('track source buttons reveal their exact library file and rows show track badges', async page => {
    const nested = listing.entries.find(entry => entry.name === 'review/shots/path-tooltip.mp4');
    assert.ok(nested);
    const other = listing.entries.find(entry => entry.name === 'ci_h264_smoke.mp4');
    assert.ok(other);
    await page.evaluate(async ids => {
      const load = window.voidPlayer.tools.find(tool => tool.name === 'load_library_item');
      await load.execute({ id: ids[0], slot: 'B' }); await load.execute({ id: ids[1], slot: 'C' });
    }, [nested.id, other.id]);
    await page.locator('#toggle-sources').click();
    await page.locator('#sources-search-toggle').click();
    await page.locator('#source-search').fill('no-file-matches-this');
    await page.locator('#source-list .panel-empty').waitFor();
    const offsets = [];
    await page.route('**/api/library/browse?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('root') !== nested.rootId || url.searchParams.get('directory') !== 'review/shots') return route.continue();
      const offset = Number(url.searchParams.get('offset') ?? 0); offsets.push(offset);
      const response = await route.fetch(), data = await response.json();
      const entries = offset === 0 ? Array.from({length:60}, (_, i) => ({...nested, id:`decoy-${i}`, name:`review/shots/decoy-${i}.mp4`})) : [nested];
      await route.fulfill({response, json:{...data, entries, directories:[], total:61, offset, nextOffset:offset === 0 ? 60 : null}});
    });
    for (const slot of ['B', 'C']) {
      await page.locator(`#source-activity-track-${slot}`).click();
      await page.waitForFunction(name => document.querySelector('#source-list .source-row.is-located .filename')?.textContent === name, slot === 'B' ? 'path-tooltip.mp4' : 'ci_h264_smoke.mp4');
      const row = page.locator('#source-list .source-row.is-located');
      assert.equal(await row.locator('.filename').textContent(), slot === 'B' ? 'path-tooltip.mp4' : 'ci_h264_smoke.mp4');
      assert.deepEqual(await row.locator('.source-track-badges .slot').allTextContents(), [slot]);
      const badge = row.locator('.source-meta .source-track-badges .slot');
      assert.equal(await badge.count(), 1, 'track badge lives in the metadata row');
      const badgeBox = await badge.boundingBox();
      assert.equal(badgeBox.width, badgeBox.height, 'track badge stays square');
      assert.equal(await page.locator('#source-search').inputValue(), '');
      assert.equal(await page.locator('#sources-search-toggle').getAttribute('aria-expanded'), 'false');
      if (slot === 'B') assert.match(await page.locator('#library-location').inputValue(), /review\/shots/);
      const box = await row.boundingBox(), list = await page.locator('#source-list').boundingBox(), foot = await page.locator('#source-foot').boundingBox();
      assert.ok(box.y >= list.y && box.y + box.height <= foot.y + 1, 'located file is visible above the footer');
      assert.equal(await page.locator('#source-activity-details').isVisible(), false, 'locating keeps the details folded');
    }
    assert.deepEqual(offsets, [0, 60], 'locate automatically reaches files beyond the first page');
    await page.locator('#remove-track-B').click();
    await page.waitForFunction(() => document.querySelector('#source-list .source-track-badges')?.textContent === 'C');
    await page.screenshot({ path: path.join(screenshots, `${browserName}-source-locate-badges.png`) });
  });

  await check('eight-track presentation status keeps one row and stable load-stage geometry', async page => {
    // Exercise the production view with deterministic session publications so
    // brief decoder milestones and unknown-length reads are all observable.
    const fixture = await buildFixture({ configFile: false, logLevel: 'silent', build: {
      write: false, minify: false, lib: { entry: path.join(root, 'src/ui/source-activity.ts'), formats: ['iife'], name: 'SourceActivityFixture' },
    } });
    const script = [fixture].flat().flatMap(output => output.output).find(output => output.type === 'chunk').code;
    const markup = await page.locator('#source-foot').evaluate(element => element.outerHTML);
    const sheets = await page.locator('link[rel=stylesheet]').evaluateAll(elements => elements.map(element => element.href));
    await page.route('**/activity-fixture', route => route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">${sheets.map(href => `<link rel="stylesheet" href="${href}">`).join('')}</head><body><aside id="sources-panel" class="sources-panel side-panel glass" style="position:relative;width:250px;height:500px"><div id="source-list" class="source-list"></div>${markup}</aside></body></html>` }));
    await page.goto(`${base}/activity-fixture`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      let listener;
      const tracks = [...'ABCDEFGH'].map(slot => ({ slot, id: `media-${slot}`, sourceGen: 1, name: `camera-${slot}-long-source-name.mp4`, width: 1920, height: 1080, size: 1000, visible: true, indexState: 'complete' }));
      window.activityState = { tracks, mediaLoad: null };
      window.activityStartedAt = Date.now() - 15000;
      window.publishActivity = load => { window.activityState.mediaLoad = load; listener(); };
      window.activityLife = new AbortController();
      SourceActivityFixture.installSourceActivity({ getState: () => window.activityState, subscribe: cb => { listener = cb; return () => {}; }, cancelLoad: () => window.publishActivity({ ...window.activityState.mediaLoad, state: 'cancelled', finishedAt: Date.now() }) }, window.activityLife.signal);
    });
    const toggle = page.locator('#source-activity-toggle'), tabs = page.locator('#source-activity-tracks');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#source-activity-details').isVisible(), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const foldSamples = await page.evaluate(async () => {
      const details = document.querySelector('#source-activity-details'), foot = document.querySelector('#source-foot');
      const samples = [];
      for (const expanded of [true, false]) {
        document.querySelector('#source-activity-toggle').click();
        const frames = [], deadline = performance.now() + 350;
        while (performance.now() < deadline) {
          await new Promise(requestAnimationFrame);
          frames.push({ height: details.getBoundingClientRect().height, foot: foot.getBoundingClientRect().height,
            reserve: parseFloat(document.querySelector('#sources-panel').style.getPropertyValue('--foot-h')) });
        }
        samples.push({ expanded, frames });
      }
      return samples;
    });
    for (const { expanded, frames } of foldSamples) {
      const heights = frames.map(frame => frame.height), low = Math.min(...heights), high = Math.max(...heights);
      assert.ok(heights.some(height => height > low + 1 && height < high - 1), 'fold has intermediate heights');
      assert.ok(expanded ? heights.at(-1) > heights[0] : heights.at(-1) < heights[0], 'fold animates in the chosen direction');
      assert.ok(new Set(frames.map(frame => frame.reserve)).size > 3, 'list reserve moves throughout the animation');
      assert.ok(Math.abs(frames.at(-1).reserve - frames.at(-1).foot) <= 1, 'list reserve settles at the actual footer height');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    async function settleFold() {
      await page.locator('#source-activity-details').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await settle(page);
    }
    for (const width of [160, 200, 250, 320, 400]) {
      await page.locator('#sources-panel').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      await settle(page);
      const row = await page.locator('.source-activity-heading').boundingBox(), button = await toggle.boundingBox();
      const list = await tabs.boundingBox();
      assert.equal(await tabs.locator('button').count(), 8);
      assert.equal(await tabs.locator('button').first().evaluate(element => element.getBoundingClientRect().width), 28, 'idle progress leaves no gap beside the track letter');
      assert.equal(list.height, 28, `${width}: eight tracks never wrap`);
      assert.equal(button.width, 28, `${width}: collapse target does not shrink`);
      assert.ok(list.x + list.width <= button.x && button.x + button.width <= row.x + row.width + 1);
      await page.locator('#source-activity-track-A').focus(); await page.keyboard.press('End'); await settle(page);
      const last = await page.locator('#source-activity-track-H').boundingBox();
      assert.ok(last.x >= list.x && last.x + last.width <= list.x + list.width + 1, `${width}: keyboard reveals the last track without moving the pane`);
      assert.equal(await page.locator('#source-activity-track-H').getAttribute('aria-selected'), 'true');
      for (const expanded of [false, true]) {
        if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) { await toggle.click(); await settleFold(); }
        await settle(page);
        assert.equal(await page.locator('.source-activity-summary').isVisible(), expanded, 'collapsed state has no status text underneath');
        const foot = await page.locator('#source-foot').boundingBox();
        const reserve = await page.locator('#sources-panel').evaluate(element => parseFloat(element.style.getPropertyValue('--foot-h')));
        assert.ok(Math.abs(reserve - foot.height) <= 1, 'list reserve follows the chosen fold state');
        if ([160, 250, 400].includes(width)) await page.locator('#sources-panel').screenshot({ path: path.join(screenshots, `${browserName}-activity-eight-${width}-${expanded ? 'expanded' : 'collapsed'}.png`) });
      }
    }
    await page.locator('#sources-panel').evaluate(element => { element.style.width = '200px'; });
    const stages = ['queued', 'download', 'decode', 'inspect', 'index', 'decoder', 'first-frame', 'synchronize'];
    for (const expanded of [false, true]) {
      if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) { await toggle.click(); await settleFold(); }
      let previous;
      for (const [index, stage] of stages.entries()) {
        await page.evaluate(stage => window.publishActivity({ slot: 'H', name: 'camera-H-long-source-name.mp4', state: 'loading', stage, startedAt: window.activityStartedAt, ...(stage === 'index' ? { indexProgress: { scannedBytes: 375, totalBytes: 1000, packets: 32 } } : {}) }), stage);
        await settle(page);
        const ring = page.locator('#source-activity-track-H [role=progressbar]');
        assert.equal(await ring.getAttribute('aria-hidden'), 'false', `${stage}: progress visible while collapsed or expanded`);
        assert.equal(await ring.getAttribute('aria-valuenow'), stage === 'index' ? '37.5' : null);
        assert.equal(await ring.evaluate(element => element.classList.contains('is-waiting')), stage !== 'index');
        const circle = await ring.locator('svg').boundingBox();
        assert.equal(circle.width, 20, 'progress uses the shared compact circle');
        assert.equal(circle.height, 20);
        const geometry = await page.evaluate(() => {
          const rect = id => { const r = document.querySelector(id).getBoundingClientRect(); return [r.y, r.height]; };
          return { panel: rect('#source-activity'), row: rect('.source-activity-heading'), summary: rect('.source-activity-summary'), circle: rect('#source-activity-track-H .analysis-progress-ring') };
        });
        if (previous) assert.deepEqual(geometry, previous, `${stage}: progress never moves the footer or list during loading`);
        previous = geometry;
        assert.ok((await page.locator('#source-activity-stage').textContent()).length > 0);
        await page.locator('#sources-panel').screenshot({ path: path.join(screenshots, `${browserName}-activity-${stage}-${expanded ? 'expanded' : 'collapsed'}.png`) });
      }
    }
    await page.evaluate(() => {
      const ring = document.querySelector('#source-activity-track-H .analysis-progress-ring');
      window.activityRing = ring;
      window.activityState.mediaLoad.indexProgress = { scannedBytes: 0, totalBytes: 1000, packets: 0 };
      window.publishActivity(window.activityState.mediaLoad);
    });
    const ring = page.locator('#source-activity-track-H [role=progressbar]');
    assert.equal(await ring.getAttribute('aria-valuenow'), '0', 'known zero progress remains determinate');
    assert.equal(await ring.evaluate(element => element.classList.contains('is-waiting')), false);
    await page.evaluate(() => {
      for (let i = 1; i <= 100; i++) window.publishActivity({ ...window.activityState.mediaLoad, indexProgress: { scannedBytes: i * 10, totalBytes: 1000, packets: i } });
    });
    assert.equal(await page.evaluate(() => window.activityRing === document.querySelector('#source-activity-track-H .analysis-progress-ring')), true, 'progress publications retain the circle node');
    assert.equal(await ring.getAttribute('aria-valuenow'), '100');
    for (const state of ['complete', 'cancelled', 'error']) {
      await page.evaluate(state => window.publishActivity({ ...window.activityState.mediaLoad, state, finishedAt: Date.now(), error: state === 'error' ? '测试片源读取失败' : undefined }), state);
      await settle(page);
      assert.equal(await ring.getAttribute('aria-hidden'), 'true');
      assert.equal(await page.locator('#source-activity-cancel').isVisible(), false);
      await page.locator('#sources-panel').screenshot({ path: path.join(screenshots, `${browserName}-activity-${state}.png`) });
    }
    await page.evaluate(() => {
      const track = window.activityState.tracks.find(track => track.slot === 'A');
      track.indexState = 'building'; track.indexProgress = { scannedBytes: 250, totalBytes: 1000, packets: 80 };
      window.publishActivity(window.activityState.mediaLoad);
    });
    await page.locator('#source-activity-track-A').click();
    assert.equal(await page.locator('#source-activity-track-A [role=progressbar]').getAttribute('aria-valuenow'), '25', 'background indexing shares the progress circle after presentation');
    assert.match(await page.locator('#source-activity-stage').textContent(), /25.0%/);
    await page.locator('#sources-panel').screenshot({ path: path.join(screenshots, `${browserName}-activity-background-index.png`) });
    await page.evaluate(() => window.activityLife.abort());
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
      assert.equal(await page.locator('#source-activity-cancel').isVisible(), false, 'collapsed state only shows track controls');
      assert.equal(await page.locator('#source-activity-details').isVisible(),false,'incoming load retains the collapsed preference');
      assert.equal(await page.locator('#source-activity-track-A [role=progressbar]').getAttribute('aria-valuenow'),null,'stalled inspection has an indeterminate circle');
      await page.locator('#source-activity-toggle').click();
      assert.equal(await page.locator('#source-activity-cancel').isVisible(), true);
      await page.waitForFunction(() => !document.getElementById('source-activity-time').textContent.includes('0 秒'));
      await page.setViewportSize({ width: 600, height: 800 });
      await settle(page);
      await checkScrollBoundary(page, '#source-list');
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
      assert.equal(localBox, null, 'empty local section has no placeholder');
      assert.equal(await page.locator('#source-activity').evaluate(el => getComputedStyle(el).borderTopWidth), '0px', 'empty local section leaves no orphan divider');
      const listPaddingTop = await page.locator('#source-list').evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
      const toolsHeight = await page.locator('#source-tools').evaluate(el => el.getBoundingClientRect().height);
      assert.ok(Math.abs(listPaddingTop - toolsHeight) <= 1, 'list top padding reserves exactly the floating tools height');
      assert.ok(searchToggle.y + searchToggle.height <= files.y + listPaddingTop + 1, 'floating tools stay within the list top padding');
      assert.equal(searchToggle.y, scopeTrigger.y);
      // Only the custom rail is inset; the list still scrolls under both glass
      // panels. Check dragging over the shorter rail, including a taller footer.
      assert.ok(Math.abs(files.y - panelBox.y) <= 1 && Math.abs(files.height - panelBox.height) <= 1, 'list retains its full-height layer beneath the glass panels');
      await page.locator('#source-scrollbar').waitFor({state:'visible'});
      const rail = await page.locator('#source-scrollbar').boundingBox();
      const toolbar = await page.locator('#source-tools').boundingBox();
      assert.ok(Math.abs(rail.y - (toolbar.y + toolbar.height)) <= 1, 'scrollbar begins below the glass toolbar');
      assert.ok(Math.abs(rail.y + rail.height - footBox.y) <= 1, 'scrollbar ends above the expanded glass footer');
      const thumb = page.locator('#source-scrollbar-thumb');
      let handle = await thumb.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - rail.height, {steps:6});
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('#source-list').scrollTop <= 1);
      await settle(page);
      handle = await thumb.boundingBox();
      assert.ok(handle.y >= rail.y - 1, 'thumb remains below the toolbar at the list start');
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + rail.height - handle.height + 2, {steps:6});
      await page.mouse.up();
      await page.waitForFunction(() => { const list = document.querySelector('#source-list'); return list.scrollTop >= list.scrollHeight - list.clientHeight - 1; });
      await settle(page);
      handle = await thumb.boundingBox();
      assert.ok(handle.y + handle.height <= footBox.y + 1, 'thumb remains above the footer at the list end');
      await page.locator('#sources-search-toggle').click();
      assert.equal(await page.locator('#source-search').evaluate(el => document.activeElement === el), true, 'search toggle focuses the input');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#source-search-field').evaluate(el => el.inert && el.getAttribute('aria-hidden') === 'true'), true, 'escape closes search');
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
  await check('recent history isolates disconnected library roots and migrates resolved legacy references', async page => {
    const original = listing.entries.find(entry => entry.name === 'ci_h264_smoke.mp4');
    const foreignId = 'f'.repeat(24), foreignRoot = 'another-service-root';
    const history = [{ ...original, libraryId: original.id },
      { name: 'foreign.mp4', size: 10, lastModified: 1, libraryId: foreignId, libraryRootId: foreignRoot },
      { name: 'legacy-missing.mp4', size: 10, lastModified: 1, libraryId: 'e'.repeat(24) },
      { name: 'my-local.mp4', size: 10, lastModified: 1 }];
    let foreignRequests = 0;
    page.on('request', request => { if (request.url().includes(foreignId)) foreignRequests++; });
    await page.addInitScript(history => localStorage.setItem('voidplayer.sources.v1', JSON.stringify(history)), history);
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    await page.waitForFunction(() => document.querySelectorAll('.start-recent-row').length === 2);
    const rows = await page.locator('.start-recent-row').allTextContents();
    assert.ok(rows.some(text => text.includes(original.name)) && rows.some(text => text.includes('my-local.mp4')));
    assert.equal(foreignRequests, 0, 'other libraries are not queried against this service');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('voidplayer.sources.v1')).some(item => item.libraryRootId && item.name === 'ci_h264_smoke.mp4'));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.sources.v1')));
    assert.equal(saved.find(item => item.libraryId === original.id).libraryRootId, original.rootId);
    assert.ok(saved.some(item => item.libraryId === foreignId), 'disconnected history is retained for its own library');
    await page.locator('#toggle-sources').click();
    await page.locator('#library-root').click();
    await page.locator('#library-root-menu').getByRole('menuitemradio', { name: '最近使用', exact: true }).click();
    assert.equal(await page.locator('#source-list .source-row').count(), 2, 'both history views use the same library scope');
  });

  await check('unresolved library history keeps its origin and shares failure messages across entry points', async page => {
    const original = listing.entries.find(entry => entry.name === 'ci_h264_smoke.mp4');
    const missingId = '0'.repeat(24);
    const history = [{ ...original, libraryId: missingId, libraryRootId: original.rootId, name: 'missing-reference.mp4' }, { ...original, libraryId: original.id, version: '0'.repeat(24) }];
    await page.addInitScript(history => localStorage.setItem('voidplayer.sources.v1', JSON.stringify(history)), history);
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    const missing = page.locator('.start-recent-row').filter({ hasText: 'missing-reference.mp4' });
    await page.waitForFunction(() => document.querySelector('.start-recent-row')?.dataset.tooltip?.includes('已失效'));
    assert.match(await missing.textContent(), /媒体库.*引用不可用/);
    assert.doesNotMatch(await missing.textContent(), /本地文件/);
    await missing.click();
    const message = '媒体库引用「missing-reference.mp4」已失效或文件已移除，请在媒体库中重新选择。';
    await page.locator('.toast').filter({ hasText: message }).waitFor();
    await page.locator('#library-root').click();
    await page.locator('#library-root-menu').getByRole('menuitemradio', { name: '最近使用', exact: true }).click();
    const panel = page.locator('#source-list .source-row').filter({ hasText: 'missing-reference.mp4' });
    await panel.getByRole('button', { name: '检查媒体引用', exact: true }).click();
    assert.equal(await page.locator('.toast').filter({ hasText: message }).count(), 2, 'both entry points report the same failure');
    assert.match(await panel.textContent(), /媒体库引用不可用/);
    assert.doesNotMatch(await panel.textContent(), /本机|本地文件/);
    assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks.length, 0);
    const changed = page.locator('.start-recent-row').filter({ hasText: 'ci_h264_smoke.mp4' });
    await changed.click();
    await page.locator('.toast').filter({ hasText: '与保存的版本不一致' }).waitFor();
    await page.route(`**/api/media/${missingId}/metadata`, route => route.fulfill({ status: 503, body: '{}' }));
    await panel.getByRole('button', { name: '检查媒体引用', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.start-recent-row')?.dataset.tooltip?.includes('检查服务连接'));
    await missing.click();
    await page.locator('.toast').filter({ hasText: '无法确认媒体库引用「missing-reference.mp4」' }).waitFor();
    const logs = await page.evaluate(() => window.voidPlayer.tools.find(tool => tool.name === 'get_review_logs').execute({ limit: 2000 }));
    assert.ok(logs.events.some(event => event.data?.reason === 'missing'));
    assert.ok(logs.events.some(event => event.data?.reason === 'unavailable'));
    await page.screenshot({ path: path.join(screenshots, 'source-reference-unavailable.png') });
  });

  await check('unsupported local history requires selection from either entry point and creates no empty track', async page => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
      localStorage.setItem('voidplayer.sources.v1', JSON.stringify([{ name: 'local-history.mp4', size: 100, lastModified: 1 }]));
    });
    await page.reload(); await page.waitForFunction(() => window.voidPlayer);
    const row = page.locator('.start-recent-row').filter({ hasText: 'local-history.mp4' });
    assert.match(await row.textContent(), /本地文件.*需重新选择/);
    let chooser = page.waitForEvent('filechooser');
    await row.click(); await chooser;
    const notice = page.locator('.toast').filter({ hasText: '当前浏览器不支持保存本地文件访问权限' });
    await notice.waitFor();
    assert.match(await notice.textContent(), /刷新后仍需重新选择/);
    await page.locator('#toggle-sources').click();
    await page.locator('#library-root').click();
    await page.locator('#library-root-menu').getByRole('menuitemradio', { name: '最近使用', exact: true }).click();
    chooser = page.waitForEvent('filechooser');
    await page.locator('#source-list').getByRole('button', { name: '重新选择 local-history.mp4', exact: true }).click();
    await chooser;
    assert.equal(await notice.count(), 2);
    assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks.length, 0);
    const logs = await page.evaluate(() => window.voidPlayer.tools.find(tool => tool.name === 'get_review_logs').execute({ limit: 2000 }));
    assert.ok(logs.events.some(event => event.msg === '会话启动' && event.data.persistentLocalFiles === false));
    assert.ok(logs.events.some(event => event.data?.reason === 'unsupported'));
    await page.screenshot({ path: path.join(screenshots, 'local-history-unsupported.png') });
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
  assert.ok(completedChecks > 0, 'Browser filter matched no checks');
  console.log(`Browser regressions passed (${browserName}); status screenshots saved under artifacts/source-activity.`);
} finally {
  try { await browser?.close(); }
  finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await library?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
