import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../../../server/config.ts';
import { startService } from '../../../../server/runtime.ts';
import { writePlayerWorker } from '../../../pwa/build.mjs';

export async function verifyOfflinePlayer(browser, engine, staticDir) {
  const root = await mkdtemp(path.join(tmpdir(), 'vp-offline-')), dist = path.join(root, 'dist');
  const context = await browser.newContext({ locale: 'en-US' });
  let service;
  try {
    await cp(staticDir, dist, { recursive: true });
    await mkdir(path.join(root, 'media'));
    const config = await loadConfig(['--folder', path.join(root, 'media'), '--data-dir', root, '--static', dist], 'production');
    config.port = 0;
    config.logsDir = null;
    service = await startService(config);
    config.port = service.server.address().port;
    const base = 'http://127.0.0.1:' + config.port;
    const first = await context.newPage();
    await first.goto(base + '/');
    const status = state => `#offline-app-status[data-state="${state}"]`;
    await first.locator(status('idle')).waitFor({ state: 'attached' });
    assert.equal(await first.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)), false);
    const manifest = await first.evaluate(async () => {
      const response = await fetch(document.querySelector('link[rel=manifest]').href);
      return { mime: response.headers.get('content-type'), ...await response.json() };
    });
    assert.equal(manifest.mime, 'application/manifest+json');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.filter(icon => icon.purpose === 'any').map(icon => icon.sizes), ['192x192', '512x512']);
    if (engine === 'chromium') {
      const session = await context.newCDPSession(first);
      assert.deepEqual((await session.send('Page.getInstallabilityErrors')).installabilityErrors, []);
      await session.detach();
      await first.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    } else {
      await first.locator('#identity-welcome [data-guest]').click();
      await first.locator('#settings-open').click();
      await first.locator('#settings-tab-about').click();
      const prepare = first.getByRole('button', { name: 'Prepare for offline use' });
      const icon = path.join(dist, 'icon-512.png'), bytes = await readFile(icon);
      await writeFile(icon, 'incomplete deployment');
      await prepare.click();
      await first.locator(status('failed')).waitFor({ state: 'visible' });
      assert.deepEqual(await first.evaluate(() => caches.keys()), []);
      await writeFile(icon, bytes);
      await prepare.click();
    }
    await first.locator(status('ready')).waitFor({ state: 'attached', timeout: 45000 });
    // No media has been opened yet. All decoding below runs after the real service has stopped.
    await first.close();
    await service.close();
    service = undefined;
    const offline = await context.newPage();
    const navigation = await offline.goto(base + '/?pwa-test=offline');
    assert.equal(navigation.fromServiceWorker(), true);
    await offline.locator('#settings-open').waitFor({ state: 'visible' });
    await offline.locator(status('ready')).waitFor({ state: 'attached' });
    assert.equal(await offline.locator('html').getAttribute('lang'), 'en');
    assert.ok(await offline.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'));
    const onlineOnly = ['/admin', '/connection', '/api/health', '/missing-file', '/vendor/voidplayer-core/voidplayer-core.wasm?v=old'];
    for (const url of onlineOnly) {
      assert.equal(await offline.evaluate(url => fetch(url).then(() => true, () => false), url), false, url);
    }
    const admin = await context.newPage();
    await assert.rejects(admin.goto(base + '/admin'));
    await admin.close();
    const fixture = path.resolve('fixtures/video/ffv1_yuv422p_8bit.mkv');
    await offline.locator('#file-A').setInputFiles(fixture);
    await offline.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.frame, null, { timeout: 45000 });
    assert.equal(await offline.evaluate(() => window.voidPlayer.getState().tracks[0].decoder), 'ffmpeg-wasm');
    const next = await offline.evaluate(async () => {
      await window.voidPlayer.step(1);
      return window.voidPlayer.getState().positionUs;
    });
    assert.ok(next > 0, 'offline local file can advance a frame');
    const initial = await offline.evaluate(async () => {
      const [cacheName] = await caches.keys();
      const keys = (await (await caches.open(cacheName)).keys()).map(key => new URL(key.url));
      return { cacheName, privateUrls: keys.filter(url => url.search && !url.pathname.startsWith('/vendor/') ||
        !/^\/(?:assets\/|vendor\/|(?:index\.html|theme-init\.js|startup-guard\.js|manifest\.webmanifest|.*\.(?:png|ico|svg))$)/.test(url.pathname)).map(String) };
    });
    assert.deepEqual(initial.privateUrls, []);
    service = await startService(config);
    const range = await offline.evaluate(async () => {
      const res = await fetch('/icon-192.png', { headers: { Range: 'bytes=0-3' } });
      return [res.status, (await res.arrayBuffer()).byteLength];
    });
    assert.deepEqual(range, [206, 4], 'Range uses the server');
    assert.equal(await offline.evaluate(async () => (await fetch('/api/health')).ok), true);

    if (engine === 'chromium') {
      // Publish a second build with a real changed startup asset. An incomplete deployment fails integrity first.
      const chunks = (await readdir(path.join(dist, 'assets'))).filter(name => /\.(js|css)$/.test(name) && !/^(admin|connection-guide)-/.test(name));
      const info = JSON.parse(await readFile(path.join(dist, 'build-info.json'), 'utf8'));
      const guard = path.join(dist, 'startup-guard.js'), previous = await readFile(guard, 'utf8');
      const updated = previous + '\n// PWA update fixture\n';
      await writeFile(guard, updated);
      await writePlayerWorker(dist, chunks.map(name => 'assets/' + name), info.coreAssetDigests);
      await writeFile(guard, previous);
      const update = () => offline.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        const installed = new Promise(resolve => reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker.addEventListener('statechange', () => {
            if (['installed', 'redundant'].includes(worker.state)) resolve(worker.state);
          });
        }, { once: true }));
        await reg.update();
        return installed;
      });
      assert.equal(await update(), 'redundant');
      assert.deepEqual(await offline.evaluate(() => caches.keys()), [initial.cacheName]);
      await writeFile(guard, updated);
      assert.equal(await update(), 'installed');
      assert.ok(await offline.evaluate(async () => (await navigator.serviceWorker.ready).waiting));
      assert.equal(await offline.evaluate(() => window.voidPlayer.getState().positionUs), next);
      await offline.evaluate(() => caches.open('unrelated-cache'));
      await offline.close();
      const reopened = await context.newPage();
      await reopened.goto(base);
      await reopened.waitForFunction(async old => !(await caches.keys()).includes(old), initial.cacheName);
      assert.ok(await reopened.evaluate(() => caches.has('unrelated-cache')));
    }
    console.log(`PASS ${engine}: installable manifest, offline cold launch, isolated local decoding, online-only data and Range`);
  } finally {
    await context.close();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}
