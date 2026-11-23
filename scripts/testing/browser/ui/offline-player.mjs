import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../../../server/config.ts';
import { startService } from '../../../../server/runtime.ts';
import { annexBFixture } from '../../../../test/helpers/media/annex-b-fixture.ts';
import { isPlayerAsset, writePlayerWorker } from '../../../pwa/build.mjs';

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
    if (engine === 'webkit') await first.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15' });
    });
    await first.goto(base + '/');
    const status = state => `#web-app[data-offline="${state}"]`;
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
    for (const icon of manifest.icons) {
      const url = new URL(icon.src, base);
      const bytes = await readFile(path.join(dist, url.pathname));
      assert.equal(url.searchParams.get('v'), createHash('sha256').update(bytes).digest('hex'));
    }
    await first.locator('#identity-welcome [data-guest]').click();
    await first.locator('#settings-open').click();
    await first.locator('#settings-tab-about').click();
    const install = first.locator('.about-project #web-app').getByRole('button', { name: 'Install', exact: true });
    assert.ok(await install.isVisible());
    if (engine === 'chromium') {
      const session = await context.newCDPSession(first);
      assert.deepEqual((await session.send('Page.getInstallabilityErrors')).installabilityErrors, []);
      const parsed = await session.send('Page.getAppManifest');
      assert.deepEqual(parsed.errors, []);
      const [handler] = JSON.parse(parsed.data).file_handlers;
      assert.equal(new URL(handler.action, base).href, base + '/?open=files');
      assert.equal(parsed.manifest.launchHandler.clientMode, 'kNavigateNew');
      const extensions = Object.values(handler.accept).flat();
      for (const ext of ['.mp4', '.mkv', '.h264', '.avc', '.h265', '.hevc', '.h266', '.vvc']) assert.ok(extensions.includes(ext));
      for (const ext of ['.voidplayer', '.ts', '.gz', '.json']) assert.ok(!extensions.includes(ext));
      await session.detach();
      await first.evaluate(() => {
        window.promptCalls = 0;
        const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: async () => { window.promptCalls++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }),
        });
        window.dispatchEvent(event);
      });
      await install.click();
      assert.equal(await first.evaluate(() => window.promptCalls), 1);
      assert.ok(await install.isEnabled());
      assert.equal(await first.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)), false);
      await first.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      assert.ok(await first.getByRole('button', { name: 'Installed', exact: true }).isDisabled());
    } else {
      const notice = first.locator('.toast-message').filter({ hasText: 'File → Add to Dock' });
      await notice.waitFor();
      const row = first.locator('.about-project #web-app');
      const rowText = (await row.innerText()).trim();
      assert.deepEqual(rowText.split(/\s+/), ['Web', 'app', 'Install']);
      const bounds = await row.boundingBox();
      await install.click();
      const installGuidance = /File → Add to Dock.*Finder.*desktop Chrome or Edge/;
      const warning = first.getByRole('alert').filter({ hasText: installGuidance });
      await warning.waitFor();
      await install.click();
      assert.equal(await first.locator('.toast-warning:not([data-leaving])').filter({ hasText: installGuidance }).count(), 1);
      assert.equal((await row.innerText()).trim(), rowText);
      assert.equal((await row.boundingBox()).height, bounds.height);
      await first.reload();
      await first.locator('#settings-open').click();
      await first.locator('#settings-tab-about').click();
      assert.equal(await notice.count(), 0);
      assert.equal((await row.innerText()).trim(), rowText);
      assert.equal(await first.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)), false);
      await first.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
      const icon = path.join(dist, 'icon-maskable-512.png'), bytes = await readFile(icon);
      await writeFile(icon, 'incomplete deployment');
      await first.reload();
      await first.locator(status('failed')).waitFor({ state: 'attached' });
      assert.equal(await first.locator('#web-app-install').textContent(), 'Installed');
      assert.deepEqual(await first.evaluate(() => caches.keys()), []);
      await writeFile(icon, bytes);
      await first.reload();
    }
    await first.locator(status('ready')).waitFor({ state: 'attached', timeout: 45000 });
    // No media has been opened yet. All decoding below runs after the real service has stopped.
    await first.close();
    await service.close();
    service = undefined;
    const offline = await context.newPage();
    if (engine === 'chromium') await offline.addInitScript(() => {
      // Supply the OS delivery boundary without changing the host's default applications.
      Object.defineProperty(window, 'launchQueue', { value: { setConsumer(fn) { window.deliverFiles = fn; } } });
    });
    const navigation = await offline.goto(base + (engine === 'chromium' ? manifest.file_handlers[0].action : '/?pwa-test=offline'));
    assert.equal(navigation.fromServiceWorker(), true);
    await offline.locator('#settings-open').waitFor({ state: 'visible' });
    await offline.locator(status('ready')).waitFor({ state: 'attached' });
    assert.equal(await offline.locator('#web-app-install').textContent(), 'Install', 'a cached ordinary tab is not an installed app window');
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
    const fixtureB = path.resolve('fixtures/video/ffv1_yuv444p_8bit.mkv');
    async function deliverBytes(filename, bytes) {
      await offline.evaluate(async ({ filename, encoded }) => {
        const root = await navigator.storage.getDirectory();
        const video = await root.getFileHandle(filename, { create: true });
        const stream = await video.createWritable();
        await stream.write(Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0)));
        await stream.close();
        window.deliverFiles({ files: [video] });
      }, { filename, encoded: bytes.toString('base64') });
    }
    const deliverFixture = async (name, file) => deliverBytes(name, await readFile(file));
    const raw = await annexBFixture(path.resolve('fixtures/video/h266_10s_1920x1080.mp4'), 'vvc', 16);
    if (engine === 'chromium') await deliverBytes('offline-clip.h266', raw.bytes);
    else await offline.locator('#file-A').setInputFiles({ name: 'offline-clip.h266', mimeType: 'video/h266', buffer: raw.bytes });
    await offline.waitForFunction(() => window.voidPlayer.getState().tracks.some(track => track.name === 'offline-clip.h266' && track.frame));
    assert.equal(await offline.evaluate(() => window.voidPlayer.getState().tracks[0].container), 'annexb');
    await offline.evaluate(() => window.voidPlayer.step(1));
    assert.equal(await offline.evaluate(() => window.voidPlayer.getState().tracks[0].frame.ptsUs), 16683);
    await offline.locator('#remove-track-A').click();
    await offline.waitForFunction(() => !window.voidPlayer.getState().tracks.length);
    if (engine === 'chromium') await deliverFixture('offline-clip.mkv', fixture);
    else await offline.locator('#file-A').setInputFiles(fixture);
    await offline.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.frame, null, { timeout: 45000 });
    assert.equal(await offline.evaluate(() => window.voidPlayer.getState().tracks[0].decoder), 'ffmpeg-wasm');
    await offline.locator('#toggle-super-resolution').click();
    const enhancement = offline.locator('#super-resolution-panel');
    const apply = enhancement.getByRole('button', { name: 'Apply enhancements', exact: true });
    const scaleOptions = enhancement.getByRole('group', { name: 'Upscale factor', exact: true }).getByRole('button');
    const scale2 = scaleOptions.filter({ hasText: '2×' });
    const scale4 = scaleOptions.filter({ hasText: '4×' });
    const pressed = button => button.getAttribute('aria-pressed');
    assert.equal(await scaleOptions.count(), 2);
    const [toggleBox, firstScale] = await Promise.all([apply.boundingBox(), scale2.boundingBox()]);
    assert.ok(toggleBox && firstScale);
    assert.equal(toggleBox.width, toggleBox.height);
    assert.ok(toggleBox.x + toggleBox.width <= firstScale.x, 'enhancement toggle is to the left of the scale options');
    assert.ok(Math.abs(toggleBox.y + toggleBox.height / 2 - firstScale.y - firstScale.height / 2) <= 1);
    assert.equal(await apply.getAttribute('aria-pressed'), 'false');
    const trackA = enhancement.getByRole('button', { name: 'A', exact: true });
    assert.equal(await trackA.getAttribute('aria-current'), 'true');
    assert.equal(await trackA.getAttribute('aria-pressed'), 'false');
    const sharpen = enhancement.getByRole('group', { name: 'Sharpen', exact: true });
    const sharpOff = sharpen.getByRole('button', { name: 'Off', exact: true });
    const kernel = sharpen.getByRole('button', { name: '7×7', exact: true });
    const kernelB = sharpen.getByRole('button', { name: '3×3', exact: true });
    const strength = enhancement.getByRole('slider');
    assert.equal(await enhancement.getByRole('checkbox').count(), 0);
    assert.equal(await pressed(sharpOff), 'true');
    assert.ok(await strength.isHidden());
    await kernel.click();
    await strength.fill('85');
    assert.equal(await enhancement.locator('[data-strength-value]').innerText(), '85%');
    const [width, height] = await offline.evaluate(() => {
      const frame = window.voidPlayer.captureFrame('A');
      return [frame.width, frame.height];
    });
    const restingPanel = await enhancement.boundingBox();
    const restingToggle = await apply.boundingBox();
    await apply.evaluate(button => {
      button.addEventListener('click', () => {
        const output = button.closest('#super-resolution-panel').querySelector('[data-status]');
        window.pendingEnhancement = { state: output.dataset.state, text: output.textContent, tooltip: output.getAttribute('data-tooltip') };
      }, { once: true });
    });
    await apply.click();
    assert.deepEqual(await offline.evaluate(() => window.pendingEnhancement), { state: 'loading', text: '', tooltip: null });
    const resolution = enhancement.getByText(`${width * 2} × ${height * 2}`, { exact: true });
    await resolution.waitFor();
    const [labelBox, resolutionBox] = await Promise.all([enhancement.getByText('Upscale factor', { exact: true }).boundingBox(), resolution.boundingBox()]);
    assert.ok(labelBox && resolutionBox && restingToggle);
    assert.ok(resolutionBox.x >= labelBox.x + labelBox.width && resolutionBox.x + resolutionBox.width <= restingToggle.x);
    assert.ok(Math.abs(resolutionBox.y - labelBox.y) <= 1, 'output resolution is on the upscale label’s row');
    assert.deepEqual(await enhancement.boundingBox(), restingPanel, 'showing enhancement status leaves the panel in place');
    assert.deepEqual(await apply.boundingBox(), restingToggle, 'the toggle stays under the pointer');
    await scale4.click();
    await enhancement.getByText(`${width * 4} × ${height * 4}`, { exact: true }).waitFor();
    assert.equal(await trackA.getAttribute('aria-pressed'), 'true');

    if (engine === 'chromium') await deliverFixture('offline-clip-b.mkv', fixtureB);
    else await offline.locator('#file-B').setInputFiles(fixtureB);
    const trackB = enhancement.getByRole('button', { name: 'B', exact: true });
    await trackB.waitFor();
    assert.equal(await trackB.getAttribute('aria-pressed'), 'false');
    const [widthB, heightB] = await offline.evaluate(() => {
      const frame = window.voidPlayer.captureFrame('B');
      return [frame.width, frame.height];
    });
    await trackB.click();
    await enhancement.getByText(`${widthB * 2} × ${heightB * 2}`, { exact: true }).waitFor();
    assert.equal(await trackB.getAttribute('aria-current'), 'true');
    assert.equal(await trackB.getAttribute('aria-pressed'), 'true');
    assert.equal(await trackA.getAttribute('aria-pressed'), 'true');
    assert.equal(await pressed(sharpOff), 'true');
    await kernelB.click();
    await strength.fill('125');

    await trackA.click();
    assert.equal(await trackA.getAttribute('aria-current'), 'true');
    assert.equal(await trackA.getAttribute('aria-pressed'), 'true');
    assert.equal(await pressed(scale4), 'true');
    assert.equal(await pressed(kernel), 'true');
    assert.equal(await enhancement.locator('[data-strength-value]').innerText(), '85%');
    await trackA.click();
    assert.equal(await trackA.getAttribute('aria-pressed'), 'false');
    assert.equal(await trackB.getAttribute('aria-pressed'), 'true');
    await trackB.click();
    await enhancement.getByText(`${widthB * 2} × ${heightB * 2}`, { exact: true }).waitFor();
    await apply.click();
    assert.equal(await trackB.getAttribute('aria-pressed'), 'false');
    await trackA.click();
    await apply.press('Escape');
    assert.ok(await enhancement.isHidden());
    assert.ok(await offline.locator('#toggle-super-resolution').evaluate(button => button === document.activeElement));
    await offline.locator('#toggle-super-resolution').click();
    assert.equal(await pressed(kernel), 'true');
    await enhancement.locator('[data-close]').click();
    const next = await offline.evaluate(async () => {
      await window.voidPlayer.step(1);
      return window.voidPlayer.getState().positionUs;
    });
    assert.ok(next > 0, 'offline local file can advance a frame');
    if (engine === 'chromium') {
      await offline.evaluate(async () => {
        const state = window.voidPlayer.exportState(); state.positionUs = 0;
        await window.voidPlayer.applyState(state);
      });
      assert.equal(await offline.evaluate(() => window.voidPlayer.getState().positionUs), 0);
      await offline.evaluate(() => window.voidPlayer.step(1));
    } else {
      await offline.reload();
      await offline.waitForFunction(() => !!window.voidPlayer);
      await offline.locator('#file-A').setInputFiles(fixture);
      await offline.waitForFunction(() => !!window.voidPlayer.getState().tracks[0]?.frame);
      const enhancementButton = offline.locator('#toggle-super-resolution');
      await enhancementButton.click();
      assert.equal(await pressed(trackA), 'false');
      assert.equal(await pressed(apply), 'false');
      assert.equal(await pressed(scale4), 'true');
      assert.equal(await pressed(kernel), 'true');
      assert.equal(await strength.inputValue(), '85');
      await enhancement.locator('[data-close]').click();
    }
    const initial = await offline.evaluate(async icons => {
      const [cacheName] = await caches.keys();
      const keys = (await (await caches.open(cacheName)).keys()).map(key => new URL(key.url));
      const iconUrls = icons.map(icon => new URL(icon.src, location.origin).href);
      const tabIcons = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map(link => link.href);
      const offlineIcons = await Promise.all([...iconUrls, ...tabIcons].map(async url => (await fetch(url)).ok));
      const notices = ['/licenses/websr.txt', '/licenses/websr-source.json'];
      const [license, source] = await Promise.all(notices.map(url => fetch(url)));
      return { cacheName, tabIcons, offlineIcons, license: await license.text(), source: await source.json(),
        privateUrls: keys.filter(url => !notices.includes(url.pathname) && (url.search && !url.pathname.startsWith('/vendor/') && !iconUrls.includes(url.href) ||
        !/^\/(?:assets\/|vendor\/|(?:index\.html|theme-init\.js|startup-guard\.js|manifest\.webmanifest|.*\.(?:png|ico|svg))$)/.test(url.pathname))).map(String) };
    }, manifest.icons);
    assert.deepEqual(initial.privateUrls, []);
    assert.ok(initial.offlineIcons.every(Boolean));
    assert.match(initial.license, /^MIT License/);
    assert.match(initial.source.weights.sha256, /^[a-f0-9]{64}$/);
    assert.equal(initial.tabIcons.length, 3);
    for (const url of initial.tabIcons) assert.match(new URL(url).pathname, /^\/assets\/(?:favicon|apple-touch-icon)-.+\.(?:ico|svg|png)$/);
    service = await startService(config);
    const range = await offline.evaluate(async () => {
      const res = await fetch('/icon-192.png', { headers: { Range: 'bytes=0-3' } });
      return [res.status, (await res.arrayBuffer()).byteLength];
    });
    assert.deepEqual(range, [206, 4], 'Range uses the server');
    assert.equal(await offline.evaluate(async () => (await fetch('/api/health')).ok), true);

    if (engine === 'chromium') {
      // Publish a second build with a real changed startup asset. An incomplete deployment fails integrity first.
      const chunks = (await readdir(path.join(dist, 'assets'))).map(name => 'assets/' + name).filter(isPlayerAsset);
      const info = JSON.parse(await readFile(path.join(dist, 'build-info.json'), 'utf8'));
      const nextBuild = randomUUID();
      await writeFile(path.join(dist, 'build-info.json'), JSON.stringify({ ...info, buildId: nextBuild }));
      const guard = path.join(dist, 'startup-guard.js'), previous = await readFile(guard, 'utf8');
      const updated = previous + '\n// PWA update fixture\n';
      const index = path.join(dist, 'index.html');
      const nextHtml = (await readFile(index, 'utf8')).replace('<head>', '<head><meta name="next-build" content="true">');
      await writeFile(index, nextHtml);
      await writeFile(guard, updated);
      await writePlayerWorker(dist, chunks, info.coreAssetDigests);
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
      const parallel = await context.newPage();
      await parallel.goto(base);
      assert.equal(await parallel.locator('meta[name=next-build]').count(), 0, 'a waiting update cannot mix new HTML into the active module graph');
      assert.equal(await parallel.evaluate(() => fetch('/startup-guard.js').then(r => r.text())), previous);
      const lazy = chunks.find(file => file.startsWith('assets/js-container-media-') && file.endsWith('.js'));
      assert.ok(lazy, 'the JS container loader is a lazy player module');
      const lazyFile = path.join(dist, lazy), lazyBytes = await readFile(lazyFile);
      await rm(lazyFile);
      assert.equal((await fetch(base + '/' + lazy)).status, 404);
      await parallel.evaluate(url => import(url).then(() => true), '/' + lazy);
      await writeFile(lazyFile, lazyBytes);
      await parallel.close();
      // Use the regular update button. Clear the same-tab preference cache to exercise the workspace handoff itself.
      await offline.route('**/api/health', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), frontendBuildId: nextBuild } });
      });
      await offline.evaluate(() => {
        for (const key of Object.keys(sessionStorage)) if (key.startsWith('voidplayer.enhancement-preferences.')) sessionStorage.removeItem(key);
        window.dispatchEvent(new Event('focus'));
      });
      await offline.locator('#server-update').click();
      await offline.locator('meta[name=next-build]').waitFor({ state: 'attached' });
      await offline.waitForFunction(() => window.voidPlayer?.getState().tracks.filter(track => track.frame).length === 2 &&
        !document.getElementById('app').hasAttribute('data-workspace-opening'), null, { timeout: 45000 });
      await offline.unroute('**/api/health');
      assert.equal(await offline.evaluate(() => window.voidPlayer.getState().positionUs), next);
      assert.equal(await offline.evaluate(() => sessionStorage.getItem('voidplayer.update-state.v1')), null);
      await offline.locator('#toggle-super-resolution').click();
      assert.equal(await pressed(trackA), 'false');
      assert.equal(await pressed(trackB), 'false');
      assert.equal(await pressed(apply), 'false');
      assert.equal(await pressed(scale4), 'true');
      assert.equal(await pressed(kernel), 'true');
      assert.equal(await strength.inputValue(), '85');
      await trackB.click();
      assert.equal(await pressed(scale2), 'true');
      assert.equal(await pressed(kernelB), 'true');
      assert.equal(await strength.inputValue(), '125');
      await offline.locator('#remove-track-B').click();
      await trackB.waitFor({ state: 'detached' });
      await offline.evaluate(() => caches.open('unrelated-cache'));
      await offline.close();
      const reopened = await context.newPage();
      await reopened.goto(base);
      await reopened.waitForFunction(async old => !(await caches.keys()).includes(old), initial.cacheName);
      assert.equal(await reopened.locator('meta[name=next-build]').count(), 1);
      assert.ok(await reopened.evaluate(() => caches.has('unrelated-cache')));
    }
    console.log(`PASS ${engine}: installable manifest, offline cold launch and WebSR 2×/4×, isolated local decoding, online-only data and Range`);
  } finally {
    await context.close();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}
