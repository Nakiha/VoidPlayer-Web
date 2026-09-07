import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
const temp = await mkdtemp(path.join(os.tmpdir(), 'vp-identity-browser-'));
let service, browser;
try {
  await mkdir(path.join(temp, 'media'));
  const config = await loadConfig(['--folder', path.join(temp, 'media'), '--data-dir', temp], 'production'); config.port = 0; config.logsDir = null;
  service = await startService(config); config.port = service.server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const a = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const b = await browser.newContext(); const errors = [];
  const page = await a.newPage(), other = await b.newPage();
  for (const p of [page, other]) p.on('pageerror', error => errors.push(error.message));
  const settings = async p => { await p.locator('#settings-open').click(); await p.locator('#settings-tab-identity').click(); await p.waitForFunction(() => !document.querySelector('#identity-name').disabled); };
  await page.goto(base); await settings(page);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.identity'))); assert.ok(cached.name && cached.id);
  const id = await page.locator('#identity-id').getAttribute('title'); assert.ok(id);
  assert.equal(await page.locator('#identity-id').innerText(), `ID · ${id.slice(0, 8)}`);
  await page.locator('#identity-name').fill('小明'); await page.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明' && !document.querySelector('#identity-save').disabled);
  assert.equal(await page.locator('#identity-id').getAttribute('title'), id);
  await other.goto(base); await settings(other);
  const otherId = await other.locator('#identity-id').getAttribute('title'); assert.notEqual(otherId, id);
  await other.locator('#identity-users').selectOption(id);
  await other.waitForFunction(() => document.querySelector('#identity-current').textContent === '小明');
  assert.equal(await other.locator('#identity-id').getAttribute('title'), id);
  // Editing from another tab updates the name without replacing the user ID.
  const tab = await a.newPage(); await tab.goto(base); await settings(tab);
  await tab.locator('#identity-name').fill('新名字'); await tab.locator('#identity-save').click();
  await page.waitForFunction(() => document.querySelector('#identity-current').textContent === '新名字');
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('title'), id);
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
  await page.reload(); await settings(page); assert.equal(await page.locator('#identity-id').getAttribute('title'), id);
  await a.clearCookies(); await page.reload(); await settings(page);
  assert.notEqual(await page.locator('#identity-id').getAttribute('title'), id);
  await page.locator('#identity-users').selectOption(id);
  await page.waitForFunction(id => document.querySelector('#identity-id').title === id, id);
  assert.deepEqual(errors, []);
  console.log('PASS identity: automatic users, unique rename, dropdown switch, cross-tab sync, reload/restart/cleared-cookie recovery, invalid input, light/dark/mobile layout');
} finally { await browser?.close(); await service?.close(); await rm(temp, { recursive: true, force: true }); }
