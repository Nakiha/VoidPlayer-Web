import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
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
  const base = `${secure ? 'https' : 'http'}://${insecure || secure ? 'voidplayer.test' : '127.0.0.1'}:${config.port}`;
  browser = await chromium.launch({ headless: true, args: insecure || secure ? ['--host-resolver-rules=MAP voidplayer.test 127.0.0.1', '--no-proxy-server'] : [], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const a = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const b = await browser.newContext(); const errors = [];
  const page = await a.newPage(), other = await b.newPage();
  for (const p of [page, other]) p.on('pageerror', error => errors.push(error.message));
  const settings = async p => { await p.locator('#settings-open').click(); await p.locator('#settings-tab-identity').click(); await p.waitForFunction(() => !document.querySelector('#identity-name').disabled); };
  const initial = await page.goto(base); await settings(page);
  if (insecure) {
    assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    assert.equal(initial.headers()['cross-origin-opener-policy'], undefined);
  }
  if (secure) {
    assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof VideoDecoder, crossOriginIsolated]), [true, 'function', true]);
    assert.equal(initial.headers()['cross-origin-opener-policy'], 'same-origin');
  }
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.identity'))); assert.ok(cached.name && cached.id);
  const id = await page.locator('#identity-id').getAttribute('data-tooltip'); assert.ok(id);
  assert.equal(await page.locator('#identity-id').innerText(), `ID · ${id.slice(0, 8)}`);
  await page.locator('#identity-name').fill('小明'); await page.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明' && !document.querySelector('#identity-save').disabled);
  assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await other.goto(base); await settings(other);
  const otherId = await other.locator('#identity-id').getAttribute('data-tooltip'); assert.notEqual(otherId, id);
  await other.locator('#identity-users').selectOption(id);
  await other.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明');
  assert.equal(await other.locator('#identity-id').getAttribute('data-tooltip'), id);
  // Editing from another tab updates the name without replacing the user ID.
  const tab = await a.newPage(); await tab.goto(base); await settings(tab);
  await tab.locator('#identity-name').fill('新名字'); await tab.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '新名字');
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await page.locator('#identity-name').fill('   '); await page.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-message').textContent.includes('1–128'));
  assert.equal(await page.locator('#identity-current').innerText(), '新名字');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `/tmp/voidplayer-identity-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 700 });
  const overflow = await page.locator('#settings-pane-identity').evaluate(e => e.scrollWidth - e.clientWidth); assert.ok(overflow <= 1);
  await page.screenshot({ path: '/tmp/voidplayer-identity-mobile.png' });
  await service.close(); service = await startService(config);
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await a.clearCookies(); await page.reload(); await settings(page);
  assert.notEqual(await page.locator('#identity-id').getAttribute('data-tooltip'), id);
  await page.locator('#identity-users').selectOption(id);
  await page.waitForFunction(id => document.querySelector('#identity-id').dataset.tooltip === id, id);
  if (process.env.VOIDPLAYER_HTTP_PLAYBACK === '1') {
    await page.locator('#settings-close').click();
    const state = await page.evaluate(async () => {
      const api = window.voidPlayer;
      const listing = await api.tools.find(t => t.name === 'list_library').execute({});
      await api.tools.find(t => t.name === 'load_library_item').execute({ slot: 'A', id: listing.entries.find(e => e.name === 'http-smoke.mp4').id });
      await api.seek(200000);
      api.addMark({ slot: 'A', text: 'HTTP smoke' });
      const state = api.getState();
      return { decoder: state.tracks[0].decoder, variant: state.tracks[0].coreVariant, frame: !!state.tracks[0].frame, marks: state.marks.length };
    });
    assert.deepEqual(state, secure ? { decoder: 'webcodecs', variant: undefined, frame: true, marks: 1 } : { decoder: 'ffmpeg-wasm', variant: 'single-thread', frame: true, marks: 1 });
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${secure ? 'trusted HTTPS + WebCodecs' : insecure ? 'ordinary HTTP' : 'localhost'} identity:`);
  console.log('PASS identity: automatic users, unique rename, dropdown switch, cross-tab sync, reload/restart/cleared-cookie recovery, invalid input, light/dark/mobile layout');
} finally { await browser?.close(); await service?.close(); untrust?.(); await rm(temp, { recursive: true, force: true }); }
