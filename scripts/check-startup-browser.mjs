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
  const builtBase = `http://127.0.0.1:${service.server.address().port}`;
  for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
    browser = await engine.launch({ headless: true });
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({locale:'zh-CN',  colorScheme: theme });
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
      assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(33, 33, 33)' : 'rgb(245, 245, 247)');
      // Shell-first reveal: the app is visible while GPU warmup is still gated.
      await page.waitForFunction(() => !document.querySelector('#app').hasAttribute('data-initializing'));
      assert.notEqual(await page.locator('#app').evaluate(el => getComputedStyle(el).visibility), 'hidden');
      assert.equal(await page.locator('#app').evaluate(el => el.inert), false);
      assert.equal(await page.locator('#startup-fallback').isVisible(), false);
      await page.evaluate(() => window.releaseStartupGpu());
      await page.waitForFunction(() => window.startupFrames.length > 2);
      assert.ok((await page.evaluate(() => window.startupFrames)).every(frame => frame.ready && frame.single && !frame.inert));
      assert.deepEqual(errors, []);
      await page.locator('#identity-welcome').waitFor();
      await page.locator('#identity-welcome').evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)); });
      await page.screenshot({ path: `/tmp/voidplayer-startup-${name}-${theme}.png` });
      await page.close();
    }
    // Static bootstrap dependencies fail before bootstrap's try/catch runs.
    // Also cover the entry itself and main's dynamic import, with a real retry.
    for (const target of ['**/src/bootstrap.ts*', '**/src/i18n/generated/zh-CN.js*', '**/src/main.ts*', '**/@messageformat_runtime.js*']) {
      const failed = await browser.newPage({locale:'zh-CN'});
      let blocked = 0;
      await failed.route(target, route => { blocked++; return route.fulfill({ status: 504, body: 'Outdated Optimize Dep' }); });
      await failed.goto(base);
      await failed.locator('#startup-fallback a').waitFor({state:'visible',timeout:5000});
      // Dynamic imports can begin after the document's load event.
      assert.ok(blocked > 0, `failure injection must reach ${target}`);
      assert.equal(await failed.locator('#app').evaluate(el => el.inert), false);
      assert.equal(await failed.locator('#app').isVisible(), false);
      await failed.unroute(target);
      await failed.locator('#startup-fallback a').click();
      await failed.locator('#settings-open').waitFor({state:'visible'});
      assert.equal(await failed.locator('#startup-fallback').isVisible(), false);
      await failed.close();
    }
    // Built HTML has a hoisted module entry without the development marker.
    const built = await browser.newPage({locale:'zh-CN'});
    const builtErrors = [];
    built.on('pageerror', error => builtErrors.push(error.message));
    await built.route('**/assets/player-*.js', route => route.fulfill({status:504, headers:{'cache-control':'no-store'}, body:'Unavailable module'}));
    await built.goto(builtBase);
    await built.locator('#startup-fallback a').waitFor({state:'visible', timeout:5000});
    assert.equal(await built.locator('#app').isVisible(), false);
    await built.screenshot({path:`/tmp/voidplayer-startup-failure-${name}.png`});
    await built.unroute('**/assets/player-*.js');
    await built.locator('#startup-fallback a').click();
    await built.locator('#settings-open').waitFor({state:'visible'});
    assert.equal(await built.locator('#startup-fallback').isVisible(), false);
    assert.deepEqual(builtErrors, []);
    await built.close();
    // A hanging request has no error event. The deadline exposes retry, while
    // a late successful load must be able to replace the fallback with the UI.
    const slow = await browser.newPage({locale:'zh-CN'});
    await slow.clock.install();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await slow.route('**/src/main.ts*', async route => { await gate; await route.continue(); });
    await slow.goto(base, {waitUntil:'commit'});
    await slow.locator('#startup-fallback').waitFor({state:'attached'});
    await slow.clock.fastForward(15001);
    await slow.locator('#startup-fallback a').waitFor({state:'visible'});
    assert.equal(await slow.locator('#app').isVisible(), false);
    release();
    await slow.clock.resume();
    await slow.locator('#settings-open').waitFor({state:'visible'});
    assert.equal(await slow.locator('#startup-fallback').isVisible(), false);
    // Successful startup disarms the deadline and ignores unrelated script errors.
    await slow.evaluate(() => {
      const script = document.createElement('script');
      document.body.append(script); script.dispatchEvent(new Event('error'));
    });
    await slow.clock.fastForward(20000);
    assert.equal(await slow.locator('#startup-fallback').isVisible(), false);
    await slow.close();
    await browser.close(); browser = undefined;
    console.log(`PASS ${name}: early theme, shell-first reveal, complete first UI frame, development/built entry/static/dynamic module failures, optimized dependency 504, retry, timeout/late recovery and disarmed guard`);
  }
} finally {
  await browser?.close(); await web?.close(); await service?.close();
  await rm(temp, { recursive: true, force: true });
}
