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
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
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
  for (const os of ['windows', 'macos']) {
    await page.locator(`[data-os="${os}"]`).click();
    assert.equal(await page.locator(`#connection-${os}`).isVisible(), true);
    assert.equal(await page.locator(`[data-os="${os}"]`).getAttribute('aria-pressed'), 'true');
  }
  const downloading = page.waitForEvent('download'); await page.locator('#connection-download').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'voidplayer-ca.crt');
  assert.equal(await readFile(await download.path(), 'utf8'), service.tls.ca);
  await page.locator('[data-os="windows"]').click();
  await page.screenshot({ path: '/tmp/voidplayer-connection-windows.png', fullPage: true });
  await page.locator('[data-os="macos"]').click(); await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/voidplayer-connection-macos.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/voidplayer-connection-mobile.png', fullPage: true });
  await page.route('**/api/connection', route => route.fulfill({ json: { configured: false } }));
  await page.locator('#connection-retry').click(); await page.locator('#connection-unavailable').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#connection-download').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS HTTP guide: OS steps, exact CA download, HTTPS URL, no player/WASM, mobile/dark layout, unavailable configuration');
} finally { await browser?.close(); await service?.close(); await rm(temp, { recursive: true, force: true }); }
