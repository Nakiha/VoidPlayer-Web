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
  const media = path.join(temporary, '本机媒体'); await mkdir(media); await writeFile(path.join(media, 'sample.mp4'), Buffer.alloc(4 * 1024 * 1024, 51));
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
  let [page] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL(base + '/admin'); await page.locator('#identity').filter({ hasText: '用户-' }).waitFor();
  assert.equal(await player.url(), base + '/');
  // Returning to an existing player must retain its in-memory review and tab.
  await player.evaluate(() => { window.adminReturnMarker = 'preserve-review'; });
  assert.equal(await page.evaluate(() => !!window.opener), true);
  await Promise.all([page.waitForEvent('close'), page.getByRole('link', { name: '返回播放器', exact: true }).click()]);
  assert.equal(context.pages().length, 1);
  assert.equal(await player.evaluate(() => window.adminReturnMarker), 'preserve-review');
  const direct = await context.newPage(); await direct.goto(base + '/admin');
  await direct.getByRole('link', { name: '返回播放器', exact: true }).click(); await direct.waitForURL(base + '/');
  assert.equal(context.pages().length, 2, 'direct admin visits return within their current tab'); await direct.close();
  const otherPlayer = await context.newPage(); await otherPlayer.goto(base);
  const [orphan] = await Promise.all([context.waitForEvent('page'), otherPlayer.locator('#server-status').click()]);
  await orphan.waitForURL(base + '/admin'); await otherPlayer.close();
  await orphan.getByRole('link', { name: '返回播放器', exact: true }).click(); await orphan.waitForURL(base + '/'); await orphan.close();
  [page] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#identity').filter({ hasText: '用户-' }).waitFor();

  assert.equal(await page.evaluate(() => { const rows = [...document.querySelectorAll('#pane-overview .admin-properties > div')]; return rows.every((r, i) => !i || r.getBoundingClientRect().top > rows[i-1].getBoundingClientRect().top); }), true, 'properties must remain a single ordered list');
  await page.screenshot({ path: `/tmp/voidplayer-admin-overview-light-${browserName}.png` });
  await page.route('**/api/admin/status', route => route.fulfill({ status: 503, json: { error: '服务暂不可用，请重试' } }));
  await page.locator('#refresh-status').click();
  await page.locator('#admin-message').filter({ hasText: '服务暂不可用' }).waitFor();
  await page.screenshot({ path: `/tmp/voidplayer-admin-status-error-${browserName}.png` });
  await page.unroute('**/api/admin/status');
  await page.locator('#refresh-status').click();
  await page.locator('#admin-message').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.getByLabel('目录名称').first().waitFor();
  await page.locator('.admin-root-state').filter({ hasText: '存储离线' }).waitFor();
  const aligned = await page.locator('.admin-root-row').evaluateAll(rows => rows.every(row => { const inputs = row.querySelectorAll('input'); return Math.abs(inputs[0].getBoundingClientRect().top - inputs[1].getBoundingClientRect().top) < 1; }));
  assert.equal(aligned, true, 'name and path inputs must align independently of status captions');
  await page.getByLabel('目录名称').first().fill('本机拍摄素材');
  const leavePrompt = page.waitForEvent('dialog');
  const returnClick = page.getByRole('link', { name: '返回播放器', exact: true }).click();
  await (await leavePrompt).dismiss(); await returnClick;
  assert.equal(page.isClosed(), false, 'canceling return preserves unsaved directory edits');
  assert.equal(await page.getByLabel('目录名称').first().inputValue(), '本机拍摄素材');

  // Polling is intentionally observed while editing: it must preserve the input node.
  await page.locator('#refresh-status').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('[data-field=name]')?.value === '本机拍摄素材');
  await page.getByRole('button', { name: '添加目录', exact: true }).click();
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-editing-${browserName}.png` });
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
  await page.getByRole('button', { name: '测速', exact: true }).click();
  assert.equal((await (await fetch(base + '/api/admin/measurements')).json()).job, null, 'opening the page cannot start traffic');
  assert.equal(await page.locator('#pane-measurements select').count(), 0);
  assert.equal(await page.locator('#measure-result').isVisible(), false, 'unused results stay compact');
  const choose = async (id, value) => {
    await page.locator(`#${id}`).click();
    const menu = page.locator(`#${id}-menu`);
    const triggerBox = await page.locator(`#${id}`).boundingBox(), menuBox = await menu.boundingBox();
    assert.ok(menuBox.width >= triggerBox.width - 1, `${id} menu narrower than trigger`);
    await menu.locator(`[data-value="${value}"]`).click();
  };
  await choose('measure-limit', '64'); await choose('measure-seconds', '5');
  for (const kind of ['download', 'upload', 'storage', 'concurrent']) {
    await choose('measure-kind', kind);
    if (['storage', 'concurrent'].includes(kind)) {
      await page.waitForFunction(() => [...document.querySelectorAll('#measure-media-menu button')].some(option => option.textContent.includes('sample.mp4')));
      await choose('measure-media', await page.locator('#measure-media-menu button').filter({ hasText: 'sample.mp4' }).getAttribute('data-value'));
    }
    await page.getByRole('button', { name: '开始测试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#measure-state')?.textContent.includes('已完成') && !document.querySelector('#measure-start')?.disabled);
    const result = (await (await fetch(base + '/api/admin/measurements')).json()).job;
    assert.equal(result.kind, kind); assert.ok(['limit', 'duration'].includes(result.reason), `${kind}: ${result.reason}`); assert.equal(result.errors, 0);
    assert.ok(result.bytes > 0 && result.bytes <= 64 * 1024 * 1024);
    if (kind !== 'storage') { assert.ok(result.client.bytes > 0); assert.ok(result.client.elapsedMs > 0); }
    assert.ok(!(await page.locator('#measure-rate').textContent()).includes('NaN'));
  }
  await page.screenshot({ path: `/tmp/voidplayer-admin-measure-dark-${browserName}.png` });
  await player.evaluate(() => localStorage.setItem('voidplayer.theme', 'light'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: `/tmp/voidplayer-admin-measure-light-${browserName}.png` });
  // Hold the first browser transfer so cancellation is exercised mid-task,
  // independent of how quickly localhost can exhaust the byte budget.
  await page.route('**/api/admin/measurements/*/transfer', async route => { await new Promise(r => setTimeout(r, 400)); await route.continue().catch(() => {}); });
  await choose('measure-kind', 'download');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await page.getByRole('button', { name: '取消测试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#measure-state')?.textContent.includes('已取消') && !document.querySelector('#measure-start')?.disabled);
  assert.equal((await (await fetch(base + '/api/admin/measurements')).json()).job.activeRequests, 0);
  await page.unroute('**/api/admin/measurements/*/transfer');
  for (const width of [1512, 1280, 720, 390]) {
    await page.setViewportSize({ width, height: 820 });
    for (const name of ['概览', '媒体库', '缓存', '标注', '工作区', '日志', '测速']) {
      await page.getByRole('button', { name, exact: true }).click();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.admin-content > section:not([hidden])')].every(e => e.scrollWidth <= e.clientWidth + 1));
      assert.equal(fits, true, `${name} overflows at ${width}px`);
      await page.screenshot({ path: `/tmp/voidplayer-admin-${name}-${width}-${browserName}.png` });
    }
  }
  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.screenshot({ path: `/tmp/voidplayer-admin-library-narrow-${browserName}.png` });
  assert.equal(await page.getByRole('link', { name: '返回播放器', exact: true }).isVisible(), true, 'mobile keeps a return link');
  const backBox = await page.getByRole('link', { name: '返回播放器', exact: true }).boundingBox();
  assert.ok(backBox.x >= 0 && backBox.x + backBox.width <= 390, 'mobile return link stays inside the viewport');
  // The entry is always a link, even for a non-admin or an unavailable service.
  await player.clock.install();
  let healthReads = 0;
  await player.route('**/api/health', async route => { healthReads++; await route.fulfill({ json: { service: 'voidplayer-media', capabilities: { admin: false } } }); });
  await player.reload();
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'connected');
  const beforeClick = healthReads;
  const [management] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  await management.getByRole('heading', { name: '概览', exact: true }).waitFor();
  await management.locator('#identity').filter({ hasText: '用户-' }).waitFor();
  assert.equal(healthReads, beforeClick, 'clicking the entry must not trigger a health check');
  await management.close();
  await player.bringToFront();
  const beforePoll = healthReads;
  await player.clock.runFor(10100);
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'connected');
  assert.ok(healthReads > beforePoll, 'connection polling continues automatically');
  await player.route('**/api/health', route => route.fulfill({ status: 503, json: {} }));
  await player.clock.runFor(10100);
  await player.waitForFunction(() => document.querySelector('#server-status')?.dataset.state === 'disconnected');
  const [offlineAdmin] = await Promise.all([context.waitForEvent('page'), player.locator('#server-status').click()]);
  await offlineAdmin.waitForURL(base + '/admin'); await offlineAdmin.close();
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`PASS admin ${browserName}: new-tab entry, real status, offline roots, persistent root editing, cross-tab theme, JSON/download/delete, four bounded measurements and cancellation, aligned directory fields, status recovery, and 390/720/1200/1280/1512 px layout`);
} finally { await browser?.close(); await service?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
