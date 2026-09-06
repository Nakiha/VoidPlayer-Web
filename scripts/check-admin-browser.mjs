import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-admin-browser-'));
const browserName = process.argv[2] ?? 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
let service, browser;
try {
  const media = path.join(temporary, '本机媒体'); await mkdir(media); await writeFile(path.join(media, 'sample.mp4'), 'fixture');
  const extra = path.join(temporary, 'shared-storage', '嵌套的制作素材目录'); await mkdir(extra, { recursive: true }); await writeFile(path.join(extra, 'new.mp4'), 'new');
  const file = path.join(temporary, 'voidplayer.config.json');
  await writeFile(file, JSON.stringify({ mediaRoots: [{ id: 'local', name: '本机媒体', path: media }, { id: 'offline', name: '网络归档', path: path.join(temporary, 'offline-mount') }], staticDir: path.join(root, 'dist'), dataDir: 'data', logsDir: 'logs', indexWatch: false }));
  const config = await loadConfig([], 'production', temporary); config.port = 0;
  service = await startService(config, true, { version: '0.1.0-preview', revision: 'browser-check' });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  await service.library.refresh();
  const uploaded = await fetch(base + '/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'voidplayer-web-log', sessionId: 'admin-browser', events: [{ type: 'test', text: '<script>alert(1)</script>' }] }) });
  const log = await uploaded.json(); assert.equal(uploaded.status, 201);
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 820 }, reducedMotion: 'reduce', colorScheme: 'light' });
  const player = await context.newPage(); const errors = [];
  player.on('pageerror', e => errors.push(e.message));
  await player.goto(base); await player.waitForFunction(() => document.getElementById('server-status')?.dataset.state === 'connected');
  const [page] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL(base + '/admin'); await page.locator('#identity').filter({ hasText: '本机管理员' }).waitFor();
  assert.equal(await player.url(), base + '/');
  assert.equal(await page.evaluate(() => { const rows = [...document.querySelectorAll('.admin-properties > div')]; return rows.every((r, i) => !i || r.getBoundingClientRect().top > rows[i-1].getBoundingClientRect().top); }), true, 'properties must remain a single ordered list');
  await page.screenshot({ path: `/tmp/voidplayer-admin-overview-light-${browserName}.png` });
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.getByLabel('目录名称').first().waitFor();
  await page.locator('.admin-root-state').filter({ hasText: '存储离线' }).waitFor();
  await page.getByLabel('目录名称').first().fill('本机拍摄素材');
  // Polling is intentionally observed while editing: it must preserve the input node.
  await page.locator('#refresh-status').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('[data-field=name]')?.value === '本机拍摄素材');
  await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await page.getByLabel('目录名称').last().fill('制作素材'); await page.getByLabel('服务器上的目录路径').last().fill(extra);
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.locator('#root-save-state').filter({ hasText: '目录配置已保存' }).waitFor();
  const stored = JSON.parse(await readFile(file, 'utf8')); assert.equal(stored.mediaRoots.length, 3); assert.equal(stored.mediaRoots[0].id, 'local'); assert.equal(stored.mediaRoots[0].name, '本机拍摄素材');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-light-${browserName}.png` });
  // Cross-tab theme synchronization uses the existing shared browser preference.
  await player.evaluate(() => localStorage.setItem('voidplayer.theme', 'dark'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-dark-${browserName}.png` });
  await page.getByRole('button', { name: '日志', exact: true }).click();
  await page.locator('.admin-log-item').first().click();
  await page.waitForFunction(() => document.getElementById('log-json')?.value.includes('admin-browser'));
  assert.ok((await page.locator('#log-json').inputValue()).includes('<script>'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), log.name);
  assert.equal(await page.locator('#log-json').evaluate(e => e.clientHeight > 350 && e.clientWidth > 500), true, 'log JSON must use the available content area');
  await page.screenshot({ path: `/tmp/voidplayer-admin-logs-dark-${browserName}.png` });
  await page.getByRole('button', { name: '删除选中日志', exact: true }).click(); await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await (await fetch(base + '/api/admin/logs')).json()).entries.length, 1);
  await page.getByRole('button', { name: '删除选中日志', exact: true }).click(); await page.getByRole('button', { name: '删除日志', exact: true }).click();
  await page.locator('#log-list').filter({ hasText: '暂无上传日志' }).waitFor();
  assert.equal((await (await fetch(base + '/api/admin/logs')).json()).entries.length, 0);
  for (const width of [720, 390]) {
    await page.setViewportSize({ width, height: 820 });
    for (const name of ['概览', '媒体库', '日志']) {
      await page.getByRole('button', { name, exact: true }).click();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.admin-content > section:not([hidden])')].every(e => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(fits, true, `${name} overflows at ${width}px`);
    }
  }
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-narrow-${browserName}.png` });
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`PASS admin ${browserName}: new-tab entry, real status, offline roots, persistent root editing, cross-tab theme, JSON/download/delete and 390/720/1200 px layout`);
} finally { await browser?.close(); await service?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
