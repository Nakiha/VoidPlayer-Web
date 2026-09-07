import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
const temp = await mkdtemp(path.join(tmpdir(), 'vp-guide-browser-'));
let service, browser;
try {
  await mkdir(path.join(temp, 'media'));
  const config = await loadConfig(['--folder', path.join(temp, 'media'), '--data-dir', temp, '--https', 'voidplayer.test', '--host', '127.0.0.1', '--no-logs'], 'production'); config.port = 0;
  service = await startService(config);
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP voidplayer.test 127.0.0.1', '--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  await page.emulateMedia({ colorScheme: 'light' });
  // Resolve the test hostname through loopback even on hosts with a system proxy.
  // The browser keeps a genuinely insecure remote origin; all bytes come from the real server.
  await page.route(/^http:\/\/voidplayer\.test(?::\d+)?\//, async route => {
    const request = route.request(), url = new URL(request.url());
    const host = url.host; url.hostname = '127.0.0.1';
    const response = await page.request.fetch(url.href, { method: request.method(), headers: { ...request.headers(), host }, maxRedirects: 0 });
    await route.fulfill({ response });
  });
  const errors = [], workers = [], requests = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('worker', worker => workers.push(worker)); page.on('request', request => requests.push(request.url()));
  await page.goto(`http://voidplayer.test:${service.guide.address().port}/connection`);
  await page.locator('#connection-setup').waitFor({ state: 'visible', timeout: 10000 }).catch(async error => { console.error({ url: page.url(), body: await page.locator('body').innerText(), errors, requests }); throw error; });
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof window.voidPlayer), 'undefined');
  assert.equal(workers.length, 0);
  assert.ok(!requests.some(url => /\/vendor\/|\/assets\/main-|\/api\/media\//.test(url)), 'guide must not load player or decoders');
  assert.equal(await page.locator('#connection-open').getAttribute('href'), `https://voidplayer.test:${service.server.address().port}/`);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.locator('#connection-status-row').isVisible(), false);
  assert.equal(await page.locator('#connection-retry').isVisible(), false);
  const checkExplanation = async () => {
    const geometry = () => page.evaluate(() => ({
      header: document.querySelector('.connection-header').getBoundingClientRect().height,
      cardTop: document.querySelector('.connection-card').getBoundingClientRect().top,
      height: document.documentElement.scrollHeight,
    }));
    const before = await geometry();
    await page.locator('#connection-about summary').click();
    assert.equal(await page.locator('#connection-about p').isVisible(), true);
    assert.deepEqual(await geometry(), before, 'explanation overlays without moving content or increasing page height');
    assert.ok(await page.locator('#connection-about p').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    }), 'explanation stays inside viewport');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#connection-about p').isVisible(), false);
    await page.locator('#connection-about summary').click();
    await page.locator('#connection-title').click();
    assert.equal(await page.locator('#connection-about p').isVisible(), false, 'outside click dismisses explanation');
  };
  // Browser content area after window chrome, including a conservative laptop size.
  for (const viewport of [{ width: 1512, height: 800 }, { width: 1280, height: 700 }, { width: 744, height: 794 }]) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
      await checkExplanation();
      for (const os of ['windows', 'macos']) {
        await page.locator(`[data-os="${os}"]`).click();
        assert.equal(await page.locator(`#connection-${os}`).isVisible(), true);
        assert.equal(await page.locator(`[data-os="${os}"]`).getAttribute('aria-pressed'), 'true');
        const layout = await page.evaluate(() => {
          const action = document.getElementById('connection-open').getBoundingClientRect();
          return {
            width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
            guideHeight: document.querySelector('.connection-guide').getBoundingClientRect().height,
            actionTop: action.top, actionBottom: action.bottom,
          };
        });
        const context = `${viewport.width}×${viewport.height} ${colorScheme} ${os}`;
        assert.ok(layout.width <= viewport.width, `${context}: no horizontal scrolling`);
        assert.ok(layout.height <= viewport.height, `${context}: default guide fits without scrolling (${JSON.stringify(layout)})`);
        assert.ok(layout.actionTop >= 0 && layout.actionBottom <= viewport.height, `${context}: player action is in view`);
        console.log(`FIT ${context}: content ${Math.ceil(layout.guideHeight)}px`);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  const downloading = page.waitForEvent('download'); await page.locator('#connection-download').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'voidplayer-ca.crt');
  assert.equal(await readFile(await download.path(), 'utf8'), service.tls.ca);
  await page.locator('[data-os="windows"]').click();
  await page.screenshot({ path: '/tmp/voidplayer-connection-windows.png', fullPage: true });
  await page.locator('[data-os="macos"]').click(); await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  await page.screenshot({ path: '/tmp/voidplayer-connection-macos.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkExplanation();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('.connection-fingerprint summary').click();
  assert.equal(await page.locator('#connection-fingerprint').innerText(), service.tls.fingerprint);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'expanded fingerprint fits mobile');
  await page.screenshot({ path: '/tmp/voidplayer-connection-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator("#connection-title").scrollIntoViewIfNeeded();
  await checkExplanation();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.route('**/api/connection/certificate', route => route.fulfill({ status: 503 }));
  await page.locator('#connection-download').click();
  await page.waitForFunction(() => document.getElementById('connection-status').dataset.state === 'error');
  assert.equal(await page.locator('#connection-download').getAttribute('aria-busy'), null);
  assert.match(await page.locator('#connection-download').innerText(), /重试下载/);
  await page.unroute('**/api/connection/certificate');
  const retryDownload = page.waitForEvent('download');
  await page.locator('#connection-download').click(); await retryDownload;
  assert.equal(await page.locator('#connection-status').getAttribute('data-state'), 'ready');
  await page.route('**/api/connection', route => route.fulfill({ json: { configured: false } }));
  await page.reload(); await page.locator('#connection-unavailable').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#connection-download').isVisible(), false);
  await page.unroute('**/api/connection');
  await page.route('**/api/connection', route => route.fulfill({ json: { configured: true, httpsUrl: 'https://voidplayer.test:5180/', certificateUrl: null, fingerprint: null } }));
  await page.locator('#connection-retry').click();
  await page.locator('#connection-enter').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#connection-setup').isVisible(), false);
  assert.equal(await page.locator('#connection-enter-number').innerText(), '1');
  assert.match(await page.locator('#connection-enter-hint').innerText(), /自有证书/);
  assert.ok(!requests.some(url => /\/vendor\/|\/assets\/main-|\/api\/media\//.test(url)), 'theme observer stays independent of the player');
  assert.deepEqual(errors, []);
  console.log('PASS HTTP guide: OS steps, exact CA download and failure recovery, HTTPS URL, no player/WASM, 320/390px layout, laptop default without scrolling in both OS/theme variants, live theme changes, fingerprint, unavailable/custom certificate states');
} finally { await browser?.close(); await service?.close(); await rm(temp, { recursive: true, force: true }); }
