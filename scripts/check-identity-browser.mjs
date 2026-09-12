import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { trustTestCertificate } from './test-certificate-trust.mjs';
const insecure = process.env.VOIDPLAYER_HTTP_TEST === '1';
const secure = process.env.VOIDPLAYER_HTTPS_TEST === '1';
const temp = await mkdtemp(path.join(os.tmpdir(), 'vp-identity-browser-'));
let service, browser, untrust;
try {
  await mkdir(path.join(temp, 'media'));
  if (process.env.VOIDPLAYER_HTTP_PLAYBACK === '1') await writeFile(path.join(temp, 'media/http-smoke.mp4'), Buffer.from(await readFile(new URL('../test/http-smoke.mp4.base64', import.meta.url), 'utf8'), 'base64'));
  const config = await loadConfig(['--folder', path.join(temp, 'media'), '--data-dir', temp], 'production'); config.port = 0; config.logsDir = null;
  if (secure) config.tls = { hosts: ['voidplayer.test'] };
  service = await startService(config); config.port = service.server.address().port;
  if (secure) untrust = await trustTestCertificate(service.tls.caFile);
  console.log('Identity browser: service ready, certificate trust configured');
  const base = `${secure ? 'https' : 'http'}://${insecure || secure ? 'voidplayer.test' : '127.0.0.1'}:${config.port}`;
  browser = await (process.env.IDENTITY_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true, args: insecure || secure ? ['--host-resolver-rules=MAP voidplayer.test 127.0.0.1', '--no-proxy-server'] : [], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const a = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const b = await browser.newContext(); const errors = [];
  const page = await a.newPage(), other = await b.newPage();
  for (const p of [page, other]) p.on('pageerror', error => errors.push(error.message));
  const settings = async p => { await p.locator('#settings-open').click(); await p.locator('#settings-tab-identity').click(); await p.waitForFunction(() => !document.querySelector('#identity-name').disabled); if ((await p.locator('#identity-current').innerText()) !== '访客') { await p.locator('#identity-users').click(); await p.locator('#identity-users-menu [data-value=rename]').click(); } };
  const initial = await page.goto(base);
  if (insecure) {
    await page.locator('#connection-unavailable').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof window.voidPlayer), 'undefined');
    assert.deepEqual(errors, []);
    console.log('PASS ordinary HTTP: dedicated HTTPS guide, player not initialized');
  } else {
  await page.locator('#identity-welcome').waitFor({state:'visible'});
  assert.deepEqual((await page.evaluate(async () => { const response = await fetch('/api/users'); if (!response.ok) throw new Error(`User listing failed: ${response.status}`); return response.json(); })).users,[]);
  const welcome = page.locator('#identity-welcome');
  assert.equal(await welcome.locator('button[type=submit]').innerText(), '以访客身份继续');
  assert.equal(await welcome.locator('button[type=submit]').isEnabled(), true);
  const guestFill = await welcome.locator('button[type=submit]').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.equal(await welcome.locator('button[type=submit]').evaluate(el => el === document.activeElement), true);
  assert.equal(await welcome.locator('select, datalist, [role=tablist]').count(), 0);
  await page.waitForFunction(() => document.querySelector('.welcome-toggle').hidden);
  await welcome.screenshot({ path: '/tmp/voidplayer-welcome-guest.png' });
  await page.locator('#identity-welcome input').fill('初始用户');
  assert.equal(await welcome.locator('.welcome-kind').innerText(), '新用户');
  assert.notEqual(await welcome.locator('button[type=submit]').evaluate(el => getComputedStyle(el).backgroundColor), guestFill);
  assert.equal(await welcome.locator('button[type=submit]').innerText(), '以「初始用户」的身份继续');
  await welcome.screenshot({ path: '/tmp/voidplayer-welcome-new.png' });
  await page.locator('#identity-welcome button[type=submit]').click();
  await settings(page);
  console.log('Identity browser: page and settings loaded');
  if (secure) {
    assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof VideoDecoder, crossOriginIsolated]), [true, 'function', true]);
    assert.equal(initial.headers()['cross-origin-opener-policy'], 'same-origin');
  }
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.identity'))); assert.ok(cached.name && cached.id);
  const id = await page.locator('#identity-id').getAttribute('data-tooltip'); assert.ok(id);
  assert.equal(await page.locator('#identity-id').innerText(), `ID · ${id}`);
  await page.locator('#identity-name').fill('小明'); await page.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明' && !document.querySelector('#identity-save').disabled);
  assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await other.goto(base);
  const otherWelcome = other.locator('#identity-welcome'), nameInput = otherWelcome.locator('input');
  await otherWelcome.waitFor({ state: 'visible' });
  await nameInput.fill('小明');
  await other.waitForFunction(() => document.querySelector('.welcome-kind').textContent === '已有用户');
  assert.equal(await otherWelcome.locator('button[type=submit]').innerText(), '以「小明」的身份继续');
  await nameInput.fill('另一个名字');
  assert.equal(await otherWelcome.locator('.welcome-kind').innerText(), '新用户');
  await nameInput.fill('');
  await otherWelcome.locator('.welcome-toggle').click();
  assert.equal(await nameInput.getAttribute('aria-expanded'), 'true');
  await otherWelcome.locator('.welcome-toggle').click();
  assert.equal(await nameInput.getAttribute('aria-expanded'), 'false', 'second pointer click closes the list');
  await otherWelcome.locator('.welcome-toggle').click();
  assert.equal(await nameInput.getAttribute('aria-expanded'), 'true', 'third pointer click reopens the list');
  await otherWelcome.locator('[role=option]').filter({ hasText: '小明' }).click();
  assert.equal(await nameInput.inputValue(), '小明');
  assert.equal(await nameInput.getAttribute('aria-expanded'), 'false');
  await nameInput.fill('');
  await nameInput.press('ArrowDown');
  assert.ok(await nameInput.getAttribute('aria-activedescendant'));
  await nameInput.press('Enter');
  assert.equal(await nameInput.inputValue(), '小明');
  assert.equal(await otherWelcome.isVisible(), true, 'choosing an option does not submit');
  await nameInput.fill('');
  await nameInput.press('ArrowDown'); await nameInput.press('Escape');
  assert.equal(await nameInput.getAttribute('aria-expanded'), 'false');
  assert.equal(await otherWelcome.isVisible(), true);
  await otherWelcome.locator('.welcome-toggle').click();
  await nameInput.fill('无匹配');
  assert.equal(await otherWelcome.locator('.welcome-empty').innerText(), '没有匹配的用户');
  await nameInput.fill('');
  for (const colorScheme of ['light', 'dark']) {
    await other.emulateMedia({ colorScheme });
    await other.setViewportSize({ width: 390, height: 700 });
    await other.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, colorScheme);
    await otherWelcome.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    await other.screenshot({ path: `/tmp/voidplayer-welcome-dropdown-${colorScheme}.png` });
    assert.ok(await otherWelcome.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const bounds = await otherWelcome.locator('.welcome-dropdown').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 700);
  }
  await nameInput.press('Escape');
  await nameInput.fill('小明');
  await otherWelcome.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  await otherWelcome.screenshot({ path: '/tmp/voidplayer-welcome-existing.png' });
  await nameInput.fill('很长的用户名'.repeat(20));
  assert.ok(await otherWelcome.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await nameInput.fill('');
  await otherWelcome.locator('[data-guest]').click(); await settings(other);
  assert.equal(await other.locator('#identity-name').inputValue(), '访客');
  assert.equal(await other.locator('#identity-save').isDisabled(), true);
  assert.equal(await other.locator('#identity-current').isVisible(), false);
  const otherId = await other.locator('#identity-id').getAttribute('data-tooltip'); assert.notEqual(otherId, id);
  await other.locator('#identity-users').click();
  assert.equal(await other.locator('#identity-users-menu [data-value=guest]').count(), 0);
  const anchor = await other.locator('.identity-combo').boundingBox(), popup = await other.locator('#identity-users-menu').boundingBox();
  assert.ok(Math.abs(anchor.x-popup.x)<2 && Math.abs(anchor.width-popup.width)<2);
  await other.locator(`#identity-users-menu [data-value="${id}"]`).click(); await other.locator("#identity-save").click();
  await other.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明');
  assert.equal(await other.locator('#identity-id').getAttribute('data-tooltip'), id);
  await other.waitForFunction(() => !document.querySelector('#identity-users').disabled);
  await other.locator('#identity-users').focus(); await other.keyboard.press('ArrowDown');
  assert.equal(await other.locator('#identity-users-menu [aria-checked=true]').evaluate(e => e === document.activeElement), true);
  await other.locator('#settings').screenshot({ path: '/tmp/voidplayer-settings-user-menu.png' });
  await other.keyboard.press('Escape');
  assert.equal(await other.locator('#settings').evaluate(e => e.open), true);
  assert.equal(await other.locator('#identity-users').evaluate(e => e === document.activeElement), true);
  // Editing from another tab updates the name without replacing the user ID.
  const tab = await a.newPage(); await tab.goto(base); await settings(tab);
  await tab.locator('#identity-name').fill('新名字'); await tab.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '新名字');
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await page.locator('#identity-name').fill('   '); assert.equal(await page.locator('#identity-save').isDisabled(), true);
  assert.equal(await page.locator('#identity-current').innerText(), '新名字');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `/tmp/voidplayer-identity-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 700 });
  const overflow = await page.locator('#settings-pane-identity').evaluate(e => e.scrollWidth - e.clientWidth); assert.ok(overflow <= 1);
  await page.screenshot({ path: '/tmp/voidplayer-identity-mobile.png' });
  console.log('Identity browser: users, cross-tab synchronization and layout passed; restarting service');
  await service.close(); service = await startService(config);
  console.log('Identity browser: service restarted');
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await a.clearCookies(); await page.reload(); await page.locator('#identity-welcome [data-guest]').click(); await settings(page);
  assert.notEqual(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await page.locator('#identity-users').click();
  await page.locator(`#identity-users-menu [data-value="${id}"]`).click(); await page.locator("#identity-save").click();
  await page.waitForFunction(id => document.querySelector('#identity-id').dataset.tooltip === id, id);
  if (process.env.VOIDPLAYER_HTTP_PLAYBACK === '1') {
    console.log('Identity browser: loading and seeking playback sample');
    await page.locator('#settings-close').click();
    const state = await page.evaluate(async () => {
      const api = window.voidPlayer;
      const listing = await api.tools.find(t => t.name === 'list_library').execute({});
      await api.tools.find(t => t.name === 'load_library_item').execute({ slot: 'A', id: listing.entries.find(e => e.name === 'http-smoke.mp4').id });
      await api.seek(200000);
      api.addMark({ slot: 'A', text: 'HTTP smoke' });
      const state = api.getState();
      return { decoder: state.tracks[0].decoder, variant: state.tracks[0].coreVariant, frame: !!state.tracks[0].frame, marks: state.marks.length, isolated: crossOriginIsolated };
    });
    // Reference SDR mode decodes in WASM by default; the multi-thread core
    // requires cross-origin isolation, not a particular hostname.
    assert.equal(state.isolated, !insecure);
    assert.deepEqual(state, { decoder: 'ffmpeg-wasm', variant: state.isolated ? 'multi-thread' : 'single-thread', frame: true, marks: 1, isolated: !insecure });
    if (secure) {
      // Browser matching keeps the WebCodecs coverage this probe originally asserted.
      const matched = await page.evaluate(async () => {
        const api = window.voidPlayer;
        await api.tools.find(t => t.name === 'set_review_color_mode').execute({ mode: 'browser' });
        const state = api.getState();
        return { decoder: state.tracks[0].decoder, variant: state.tracks[0].coreVariant };
      });
      assert.deepEqual(matched, { decoder: 'webcodecs', variant: undefined });
    }
  }
  // The shared admin welcome also selects an existing identity without creating a duplicate.
  const returningContext = await browser.newContext(); const returning = await returningContext.newPage();
  returning.on('pageerror', error => errors.push(error.message));
  await returning.goto(base + '/admin/');
  await returning.locator('#identity-welcome .welcome-toggle').click();
  await returning.locator('#identity-welcome [role=option]').filter({ hasText: '新名字' }).click();
  assert.equal(await returning.locator('#identity-welcome .welcome-kind').innerText(), '已有用户');
  await returning.locator('#identity-welcome .welcome-enter').click();
  await returning.locator('#identity-welcome').waitFor({ state: 'hidden' });
  assert.equal(await returning.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.identity')).id), id);
  await returningContext.close();
  // Explicit settings actions keep rename, create and switch distinct.
  const editContext = await browser.newContext(); const editPage = await editContext.newPage();
  await editPage.goto(base); await editPage.locator('#identity-welcome input').fill('原用户');
  await editPage.locator('#identity-welcome .welcome-enter').click(); await settings(editPage);
  const originalId = await editPage.locator('#identity-id').getAttribute('data-tooltip');
  await editPage.locator('#identity-users').click(); await editPage.locator('#identity-users-menu [data-value=rename]').press('Home'); await editPage.keyboard.press('Enter'); await editPage.locator('#identity-name').fill('新建的用户'); await editPage.locator('#identity-save').click();
  await editPage.waitForFunction(() => document.querySelector('#identity-current').textContent === '新建的用户');
  const createdId = await editPage.locator('#identity-id').getAttribute('data-tooltip'); assert.notEqual(createdId, originalId);
  await editPage.locator('#identity-users').click(); await editPage.locator('#identity-users-menu [data-value=rename]').click(); await editPage.locator('#identity-name').fill('原用户'); await editPage.locator('#identity-save').click();
  await editPage.locator('#identity-message').filter({ hasText: '已被使用' }).waitFor();
  assert.equal(await editPage.locator('#identity-id').getAttribute('data-tooltip'), createdId);
  assert.equal(await editPage.locator('#identity-name').inputValue(), '原用户');
  await editPage.locator('#identity-name').fill('改好的名字'); await editPage.locator('#identity-save').click();
  await editPage.waitForFunction(() => document.querySelector('#identity-current').textContent === '改好的名字');
  assert.equal(await editPage.locator('#identity-id').getAttribute('data-tooltip'), createdId);
  await editPage.locator('#settings-tab-workspace').click();
  await editPage.locator('#saved-workspace-list').filter({ hasText: '暂无工作区' }).waitFor();
  assert.equal(await editPage.locator('.saved-workspace-search').isVisible(), true);
  assert.equal(await editPage.locator('.saved-workspace-pages').isVisible(), false);
  assert.equal(await editPage.locator('#saved-workspace-share').isEnabled(), false);
  await editContext.close();
  // A failed list must not label unknown names as new; failed submission remains retryable.
  const failureContext = await browser.newContext(); const failure = await failureContext.newPage();
  failure.on('pageerror', error => errors.push(error.message));
  await failure.route('**/api/users', route => route.fulfill({ status: 503, json: { error: '不可用' } }));
  await failure.route('**/api/identity', route => route.fulfill({ status: 503, json: { error: '暂时无法进入，请重试。' } }));
  await failure.goto(base);
  await failure.locator('#identity-welcome input').fill('未知名字');
  await failure.waitForFunction(() => document.querySelector('.welcome-kind').textContent === '待确认');
  await failure.locator('.welcome-enter').click();
  await failure.locator('#identity-welcome [role=alert]').filter({ hasText: '请重试' }).waitFor();
  assert.equal(await failure.locator('#identity-welcome input').inputValue(), '未知名字');
  await failure.unroute('**/api/identity');
  await failure.locator('#identity-welcome input').fill('');
  await failure.locator('.welcome-enter').click();
  await failure.locator('#identity-welcome').waitFor({ state: 'hidden' });
  await failureContext.close();
  // A stalled list must not block visitor entry or keep the welcome dialog alive.
  const slowContext = await browser.newContext(); const slow = await slowContext.newPage();
  let releaseList;
  const listGate = new Promise(resolve => { releaseList = resolve; });
  await slow.route('**/api/users', async route => { await listGate; await route.abort().catch(() => {}); });
  await slow.goto(base);
  await slow.locator('#identity-welcome [data-guest]').click();
  await slow.locator('#identity-welcome').waitFor({ state: 'hidden', timeout: 2000 });
  releaseList(); await slowContext.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${secure ? 'trusted HTTPS + WebCodecs' : insecure ? 'ordinary HTTP' : 'localhost'} identity:`);
  console.log('PASS identity: explicit names and guests, no read-created users, unique rename, dropdown switch, cross-tab sync, reload/restart/cleared-cookie recovery, invalid input, light/dark/mobile layout');
  }
} finally {
  console.log('Identity browser: closing browser'); await browser?.close();
  console.log('Identity browser: closing service'); await service?.close();
  untrust?.(); await rm(temp, { recursive: true, force: true });
  console.log('Identity browser: cleanup complete');
}
