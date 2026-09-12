import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';

const temp = await mkdtemp(join(tmpdir(), 'vp-startup-'));
let service, web, browser;
try {
  await mkdir(join(temp, 'media'));
  const config = await loadConfig(['--folder', join(temp, 'media'), '--data-dir', temp], 'production');
  config.port = 0; config.logsDir = null;
  service = await startService(config);
  web = await createServer({
    cacheDir: join(temp, 'vite-cache'), logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null, proxy: { '/api': { target: `http://127.0.0.1:${service.server.address().port}`, changeOrigin: false } } },
  });
  await web.listen();
  const base = `http://127.0.0.1:${web.httpServer.address().port}`;
  for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
    browser = await engine.launch({ headless: true });
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ colorScheme: theme });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        // Hold GPU setup after shell insertion; no real GPU/decode is needed here.
        window.releaseStartupGpu = null;
        const gate = new Promise(resolve => { window.releaseStartupGpu = resolve; });
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => { await gate; return null; } } });
        window.startupFrames = [];
        function frame() {
          const app = document.getElementById('app');
          if (app?.childElementCount && getComputedStyle(app).visibility !== 'hidden') {
            window.startupFrames.push({ ready: !!window.voidPlayer, single: !!document.querySelector('.screens.single'), inert: app.inert });
          }
          if (performance.now() < 6000) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      await page.goto(base);
      await page.waitForFunction(() => !!document.querySelector('#settings-open'));
      assert.equal(await page.locator('#app').evaluate(el => getComputedStyle(el).visibility), 'hidden');
      assert.equal(await page.locator('#app').evaluate(el => el.inert), true);
      assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(32, 33, 37)' : 'rgb(245, 245, 247)');
      await page.evaluate(() => window.releaseStartupGpu());
      await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-initializing'));
      await page.waitForFunction(() => window.startupFrames.length > 2);
      assert.ok((await page.evaluate(() => window.startupFrames)).every(frame => frame.ready && frame.single && !frame.inert));
      assert.deepEqual(errors, []);
      await page.locator('#identity-welcome').waitFor();
      await page.locator('#identity-welcome').evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)); });
      await page.screenshot({ path: `/tmp/voidplayer-startup-${name}-${theme}.png` });
      await page.close();
    }
    // A module failure must produce a visible retry instead of a permanently hidden app.
    const failed = await browser.newPage();
    await failed.route('**/src/main.ts*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await failed.goto(base);
    await failed.locator('.startup-error a').waitFor();
    assert.equal(await failed.locator('#app').evaluate(el => el.inert), false);
    await failed.unroute('**/src/main.ts*');
    await failed.locator('.startup-error a').click();
    await failed.locator('#settings-open').waitFor();
    await failed.close();
    await browser.close(); browser = undefined;
    console.log(`PASS ${name}: early theme, delayed initialization, complete first UI frame, visible failure and retry`);
  }
} finally {
  await browser?.close(); await web?.close(); await service?.close();
  await rm(temp, { recursive: true, force: true });
}
