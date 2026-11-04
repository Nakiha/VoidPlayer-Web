import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot } from '../../manifest.mjs';

const engine = process.argv[2] ?? 'webkit';
await withBrowserFixture({ caseName: 'source-access', engine, pageOptions: { reducedMotion: 'reduce' } }, async ({ page, ready, newContext, url, artifact }) => {
  const errors = [];
  const observe = target => target.on('pageerror', error => errors.push(error.message));
  observe(page);
  const call = (target, name, args = {}) => target.evaluate(({ name, args }) => window.voidPlayer.tools.find(tool => tool.name === name).execute(args), { name, args });
  const settled = target => target.waitForFunction(() => !window.voidPlayer.getState().busy);
  await ready();
  const library = await call(page, 'list_library');
  const media = library.entries.find(entry => entry.name === 'ci_h264_smoke.mp4');
  assert.ok(media);
  await call(page, 'load_library_item', { slot: 'A', id: media.id });
  await call(page, 'add_review_mark', { slot: 'A', text: 'Preserve this annotation during recovery' });
  const saved = await call(page, 'export_workspace');
  let persisted = false;
  for (let attempt = 0; attempt < 100 && !persisted; attempt++) {
    persisted = await page.evaluate(async () => {
      const request = indexedDB.open('voidplayer-workspace-checkpoints');
      const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
      try {
        const result = db.transaction('checkpoints').objectStore('checkpoints').getAll();
        const rows = await new Promise(resolve => { result.onsuccess = () => resolve(result.result); });
        return rows.some(row => row.document.marks.some(mark => mark.text === 'Preserve this annotation during recovery'));
      } finally { db.close(); }
    });
    if (!persisted) await page.waitForTimeout(50);
  }
  assert.ok(persisted, 'the original workspace checkpoint committed before reload');
  const indexRoute = '**/api/media/*/frame-index?**';
  await page.route(indexRoute, route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'MP4 播放索引版本不受支持。', code: 'index-version-unsupported' }) }));
  await page.reload();
  await page.waitForFunction(() => window.voidPlayer);
  await page.locator('#start-workspace-card').click();
  await settled(page);
  const notice = page.locator('.toast-warning').filter({ hasText: '以下片源无法打开，已跳过' });
  await notice.waitFor({ state: 'visible' });
  assert.match(await notice.innerText(), /MP4 播放索引版本不受支持。.*HTTP 400/s);
  assert.equal(await page.locator('.toast-warning').count(), 1, 'automatic recovery has one warning without a relink state');
  assert.equal(await notice.locator('.toast-action').count(), 0, 'skipped-source warnings have no recovery actions');
  assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().tracks), []);
  assert.equal(await page.locator('.workspace-relink').count(), 0);
  assert.equal(await page.evaluate(() => window.voidPlayer.getState().error), null);
  assert.deepEqual((await call(page, 'export_workspace')).marks, saved.marks);
  await page.screenshot({ path: artifact('specific-index-error.png') });
  await notice.locator('.toast-close').click();
  await page.unroute(indexRoute);
  await call(page, 'import_workspace', { document: saved });
  const recovered = await call(page, 'export_workspace');
  assert.deepEqual(recovered.tracks, saved.tracks);
  assert.deepEqual(recovered.marks, saved.marks);
  assert.ok(await page.evaluate(() => window.voidPlayer.getState().tracks[0].frame));

  const onceContext = await newContext({ reducedMotion: 'reduce' });
  await onceContext.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
    localStorage.setItem('voidplayer.sources.v1', JSON.stringify([{ name: 'old-local.mp4', size: 10, lastModified: 1 }]));
  });
  const once = await onceContext.newPage(); observe(once);
  await once.goto(url); await once.waitForFunction(() => window.voidPlayer);
  assert.equal(await once.locator('#start-library-list').getByText('old-local.mp4', { exact: true }).count(), 0);
  await once.locator('#file-A').setInputFiles({ name: 'local-once.mp4', mimeType: 'video/mp4', buffer: await readFile(path.join(repositoryRoot, 'fixtures/video/ci_h264_smoke.mp4')) });
  await once.waitForFunction(() => !!window.voidPlayer.getState().tracks[0]?.frame && !window.voidPlayer.getState().busy);
  await once.locator('#toggle-sources').click();
  assert.ok(await once.locator('#local-list').getByText('local-once.mp4', { exact: true }).count(), 'one-time files remain usable on this page');
  assert.equal(await once.evaluate(() => JSON.parse(localStorage.getItem('voidplayer.sources.v1')).filter(item => !item.libraryId).length), 0);
  await once.reload(); await once.waitForFunction(() => window.voidPlayer);
  assert.equal(await once.locator('#start-library-list').getByText('local-once.mp4', { exact: true }).count(), 0);
  assert.equal(await once.locator('#start-workspace-card').count(), 0, 'local-only recovery is not advertised without persistent file access');
  await once.locator('#settings-open').click(); await once.locator('#settings-tab-experimental').click();
  await once.locator('#local-file-access-try').click();
  await once.waitForFunction(() => !document.getElementById('local-file-access-try').disabled);
  assert.match(await once.locator('#local-file-access-status').innerText(), /未提供持久文件访问能力/);
  await once.screenshot({ path: artifact('one-time-local-files.png') });
  await once.locator('#settings-close').click();
  const mixed = structuredClone(saved);
  const localId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  mixed.media.push({ ...mixed.media[0], id: localId, name: 'missing-local.mp4', source: undefined });
  mixed.tracks.push({ slot: 'B', mediaId: localId, offsetUs: 0, visible: true });
  await once.route(indexRoute, route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'MP4 播放索引版本不受支持。' }) }));
  await call(once, 'import_workspace', { document: mixed });
  assert.equal(await once.locator('.workspace-relink').count(), 0);
  const mixedNotice = once.locator('.toast-warning').filter({ hasText: '以下片源无法打开，已跳过' });
  await mixedNotice.waitFor({ state: 'visible' });
  assert.equal(await mixedNotice.locator('.toast-action').count(), 0);
  assert.deepEqual(await once.evaluate(() => window.voidPlayer.getState().tracks), []);
  assert.match(await mixedNotice.innerText(), /missing-local.mp4/);
  await once.setViewportSize({ width: 360, height: 780 });
  const actionBounds = await mixedNotice.locator('button').evaluateAll(buttons => buttons.map(button => {
    const { left, right } = button.getBoundingClientRect(); return { left, right };
  }));
  assert.ok(actionBounds.every(bounds => bounds.left >= 0 && bounds.right <= 360), 'warning dismiss controls fit a narrow screen');
  await once.screenshot({ path: artifact('mixed-source-skipped.png') });

  // Chromium's real cloneable handle exercises storage without driving an OS picker.
  // WebKit has no native picker; check that another attempt can also be cancelled.
  const permissionContext = await newContext({ reducedMotion: 'reduce' });
  await permissionContext.addInitScript(({ persistent }) => {
    let attempts = 0;
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async function () {
      if (!navigator.userActivation.isActive) throw new Error('File picker lost user activation');
      if (++attempts === 1) throw new DOMException('Previously denied', 'NotAllowedError');
      if (!persistent) return [];
      const directory = await navigator.storage.getDirectory();
      return [await directory.getFileHandle('permission-check.mp4', { create: true })];
    } });
  }, { persistent: engine === 'chromium' });
  const permission = await permissionContext.newPage(); observe(permission);
  await permission.goto(url); await permission.waitForFunction(() => window.voidPlayer);
  await permission.locator('#settings-open').click(); await permission.locator('#settings-tab-experimental').click();
  const tryAccess = permission.locator('#local-file-access-try');
  await tryAccess.click();
  await permission.waitForFunction(() => !document.getElementById('local-file-access-try').disabled);
  assert.match(await permission.locator('#local-file-access-status').innerText(), /未能取得或保存文件访问权限/);
  await tryAccess.click();
  await permission.waitForFunction(() => !document.getElementById('local-file-access-try').disabled);
  assert.match(await permission.locator('#local-file-access-status').innerText(), engine === 'chromium' ? /已验证文件访问和句柄保存/ : /已取消选择/);
  assert.equal(await permission.evaluate(() => window.voidPlayer.getState().tracks.length), 0, 'permission check never loads or plays a video');
  await permission.screenshot({ path: artifact('file-access-retry.png') });
  assert.deepEqual(errors, []);
  console.log(`${engine}: skipped-source warnings, exact HTTP errors, one-time local files and permission retry passed`);
});
