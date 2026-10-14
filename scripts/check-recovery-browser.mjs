// Local checkpoints, explicit restore, missing-source retention and conditions.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
import { MediaLibraryIndex } from '../server/library.ts';
const directory = await mkdtemp(path.join(tmpdir(), 'vp-recovery-'));
await mkdir(path.join(directory, 'media'));
const clip = path.join(directory, 'media', 'clip.mp4');
await copyFile('fixtures/video/ci_h264_smoke.mp4', clip);
const library = new MediaLibraryIndex([path.join(directory, 'media')], { watch: false }); await library.refresh();
const server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const engine = process.argv[2] ?? 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
try {
  const context = await browser.newContext({locale:'zh-CN',  viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('voidplayer.color-mode', 'browser'));
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
  const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
  const listing = await call('list_library'); await call('load_library_item', { slot: 'A', id: listing.entries[0].id });
  await call('set_review_track_offset', { slot: 'A', offsetUs: 100000 }); await call('seek_review', { ptsUs: 800000 });
  await call('add_review_mark', { slot: 'A', text: 'checkpoint mark' });
  await call('set_review_color_mode', { mode: 'reference' });
  const snapshot = await page.evaluate(() => window.voidPlayer.exportWorkspace());
  // Wait for a committed IDB record, not just a fired save timer.
  let saved = false;
  for (let attempt = 0; attempt < 40 && !saved; attempt++) {
    saved = await page.evaluate(() => new Promise(resolve => {
      const request = indexedDB.open('voidplayer-workspace-checkpoints');
      request.onsuccess = () => {
        const db = request.result, req = db.transaction('checkpoints').objectStore('checkpoints').getAll();
        req.onsuccess = () => { resolve(req.result.some(r => r.document.marks.length && r.document.comparison.colorMode === 'reference')); db.close(); };
      };
    }));
    if (!saved) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(saved, 'checkpoint transaction committed before reload');
  const checkpointIdentity = await page.evaluate(() => sessionStorage.getItem('voidplayer.checkpoint'));
  await page.reload(); await page.waitForFunction(() => window.voidPlayer);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('voidplayer.checkpoint')), checkpointIdentity, 'reload retains its own checkpoint identity');
  assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks.length, 0, 'restoration is offered, not automatic');
  const card = page.locator('#start-workspace-card');
  await card.waitFor();
  assert.match(await card.textContent(), /clip\.mp4/);
  assert.deepEqual(await card.locator('.start-workspace-track > .slot').allTextContents(), ['A']);
  assert.equal(await card.locator('.start-workspace-track > .slot').getAttribute('class'), 'slot slot-A');
  assert.match(await card.textContent(), /1 轨道 · 1 标注 · 00:00/);
  assert.doesNotMatch(await card.textContent(), /上次的工作区/);
  assert.equal(await card.evaluate(el => {
    const card = el.getBoundingClientRect();
    const padding = getComputedStyle(el);
    if (padding.paddingLeft !== getComputedStyle(el).getPropertyValue('--space-3').trim()
      || padding.paddingTop !== getComputedStyle(el).getPropertyValue('--space-2').trim()) return false;
    const body = el.querySelector('.start-workspace-body').getBoundingClientRect();
    const tracks = el.querySelector('.start-workspace-tracks').getBoundingClientRect();
    const footer = el.querySelector('.start-workspace-footer').getBoundingClientRect();
    const arrow = el.querySelector('.start-workspace-go').getBoundingClientRect();
    return Math.abs(body.left - card.left - parseFloat(padding.paddingLeft)) < 1
      && body.right < arrow.left && footer.top >= tracks.bottom
      && Math.abs(arrow.right - card.right + parseFloat(padding.paddingRight)) < 1
      && Math.abs((arrow.top + arrow.bottom) / 2 - (card.top + card.bottom) / 2) < 1;
  }), true);
  await page.locator('.start-recent-row').first().waitFor();
  for (const width of [1280, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const workspaceGo = await card.locator('.start-workspace-go').boundingBox();
    const recentGo = await page.locator('.start-recent-go').first().boundingBox();
    assert.ok(Math.abs(workspaceGo.x - recentGo.x) < 1 && workspaceGo.width === recentGo.width,
      `${width}px workspace and recent-file chevrons share one aligned column`);
    assert.equal(await card.locator('.start-workspace-go .icon').getAttribute('data-icon'), 'caretRight');
    assert.equal(await page.locator('.start-recent-go .icon').first().getAttribute('data-icon'), 'caretRight');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.querySelector('#start-workspace-card .start-workspace-thumb img')?.naturalWidth > 0, null, { timeout: 5000 });
  assert.equal(await page.locator('.toast').filter({ hasText: '发现上次的工作区' }).count(), 0);
  assert.equal(await card.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
  if (process.env.RECOVERY_SCREENSHOTS) {
    await card.hover();
    await page.locator('#start-panel').screenshot({ path: process.env.RECOVERY_SCREENSHOTS });
  }
  await card.click();
  await page.getByText('工作区已恢复。', { exact: true }).waitFor();
  let restored = await page.evaluate(() => window.voidPlayer.exportWorkspace());
  assert.deepEqual(restored.tracks, snapshot.tracks); assert.deepEqual(restored.marks, snapshot.marks);
  assert.deepEqual(restored.comparison, snapshot.comparison); assert.equal(restored.positionUs, snapshot.positionUs);
  // Old user work is explicitly managed rather than silently evicted as cache.
  await page.evaluate(snapshot => new Promise((resolve, reject) => {
    const request = indexedDB.open('voidplayer-workspace-checkpoints');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['checkpoints','summaries'], 'readwrite'), store = tx.objectStore('checkpoints');
      const rows = store.getAll(); rows.onsuccess = () => {
        if (rows.result.length !== 1) { reject(new Error('reload created duplicate checkpoint records')); return; }
        const record = { id: 'history-old', actor: rows.result[0].actor, updatedAt: 1, document: { ...snapshot, name: '历史备份' } };
        store.put(record);
        tx.objectStore('summaries').put({ id:record.id,actor:record.actor,updatedAt:record.updatedAt,name:'历史备份',tracks:record.document.tracks.length,marks:record.document.marks.length,bytes:new TextEncoder().encode(JSON.stringify(record)).byteLength });
      };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), snapshot);
  await page.locator('#settings-open').click(); await page.locator('#settings-tab-workspace').click();
  const countMeter = page.locator('#checkpoint-history-usage [data-capacity=count] [role=meter]');
  await page.waitForFunction(() => document.querySelector('#checkpoint-history-usage [data-capacity=count] [role=meter]')?.getAttribute('aria-valuenow') === '2');
  assert.equal(await countMeter.getAttribute('aria-valuemax'), '100');
  assert.equal(await page.locator('#checkpoint-history-usage [data-capacity=bytes] [role=meter]').getAttribute('aria-valuemax'), String(64 * 1048576));
  assert.equal(await page.locator('.saved-workspace-pages').count(),1,'cloud pagination keeps its own selector');
  const historical = page.locator('.checkpoint-history-row[data-checkpoint-id="history-old"]');
  await historical.waitFor(); assert.match(await historical.textContent(), /历史备份/);
  const current = page.locator('.checkpoint-history-row').filter({ hasNotText: '历史备份' });
  assert.equal(await current.getByRole('button', { name: '删除', exact: true }).isDisabled(), true, 'active auto-save record is protected');
  const downloadPromise = page.waitForEvent('download');
  await historical.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  assert.deepEqual(exported.marks, snapshot.marks); assert.equal(exported.name, '历史备份');
  await historical.getByRole('button', { name: '恢复工作区', exact: true }).click();
  await page.waitForFunction(() => !window.voidPlayer.getState().busy && !document.querySelector('#settings').open);
  assert.deepEqual(await page.evaluate(() => window.voidPlayer.exportWorkspace().marks), snapshot.marks);
  await page.locator('#settings-open').click(); await page.locator('#settings-tab-workspace').click();
  await historical.getByRole('button', { name: '删除', exact: true }).click();
  await historical.locator('.annotation-confirm').getByRole('button', { name: '取消', exact: true }).click();
  await historical.waitFor();
  await historical.getByRole('button', { name: '删除', exact: true }).click();
  await historical.locator('.annotation-confirm').getByRole('button', { name: '删除', exact: true }).click();
  await historical.waitFor({ state: 'detached' });
  await page.locator('#settings-close').click();
  // Seed a full history atomically, then verify a new tab cannot silently grow it.
  await page.evaluate(snapshot => new Promise((resolve,reject) => {
    const request=indexedDB.open('voidplayer-workspace-checkpoints');request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction(['checkpoints','summaries'],'readwrite'),rows=tx.objectStore('checkpoints').getAll();
      rows.onsuccess=()=>{
        const owner=rows.result[0].actor;
        for(let i=0;i<99;i++){
          const record={id:`capacity-${i}`,actor:owner,updatedAt:i+1,document:snapshot};
          tx.objectStore('checkpoints').put(record);
          tx.objectStore('summaries').put({id:record.id,actor:owner,updatedAt:record.updatedAt,name:`容量历史 ${i}`,tracks:snapshot.tracks.length,marks:snapshot.marks.length,bytes:new TextEncoder().encode(JSON.stringify(record)).byteLength});
        }
      };
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};
    };
  }),snapshot);
  const newTab=await context.newPage();newTab.on('pageerror',error=>errors.push(error.message));
  await newTab.goto(base);await newTab.waitForFunction(()=>window.voidPlayer);
  await newTab.evaluate(async()=>{const tools=window.voidPlayer.tools,lib=await tools.find(t=>t.name==='list_library').execute({});await tools.find(t=>t.name==='load_library_item').execute({slot:'A',id:lib.entries[0].id});});
  await newTab.locator('.toast').filter({hasText:'本机恢复记录已达容量上限'}).waitFor({timeout:15000});
  const storedCount=()=>page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('voidplayer-workspace-checkpoints');req.onsuccess=()=>{const db=req.result,count=db.transaction('checkpoints').objectStore('checkpoints').count();count.onsuccess=()=>{resolve(count.result);db.close();};};}));
  assert.equal(await storedCount(),100,'capacity failure preserves every existing record');
  await page.locator('#settings-open').click();await page.locator('#settings-tab-workspace').click();
  await page.waitForFunction(()=>document.querySelector('#checkpoint-history-usage [data-capacity=count]')?.dataset.full === 'true');
  assert.equal(await countMeter.getAttribute('aria-valuenow'), '100');
  const oldCapacity=page.locator('.checkpoint-history-row[data-checkpoint-id="capacity-98"]');
  await oldCapacity.getByRole('button',{name:'删除',exact:true}).click();
  await oldCapacity.locator('.annotation-confirm').getByRole('button',{name:'删除',exact:true}).click();
  await oldCapacity.waitFor({state:'detached'});
  await newTab.locator('.toast').filter({hasText:'工作区本机自动恢复已恢复保存'}).waitFor({timeout:15000});
  assert.equal(await storedCount(),100,'deletion frees one slot and the new tab resumes saving');
  await newTab.close();await page.locator('#settings-close').click();
  // Make the remote source temporarily unavailable and repeat a user-directed restore.
  await rename(clip, clip + '.offline'); await library.refresh();
  await page.evaluate(document => window.voidPlayer.importWorkspace(document), snapshot);
  let state = await page.evaluate(() => window.voidPlayer.getState());
  assert.equal(state.tracks[0].pendingRelink, true); assert.equal(state.tracks[0].frame, null);
  assert.deepEqual(state.marks, snapshot.marks); assert.equal(state.tracks[0].offsetUs, 100000);
  assert.equal(await page.locator('#image-A').isVisible(), false, 'missing track must not show the previous review frame');
  await page.locator('.toast').filter({ hasText: '已失效或文件已移除' }).waitFor();
  const logs = await call('get_review_logs', { limit: 2000 });
  assert.ok(logs.events.some(event => event.msg === '工作区片源恢复失败，保留轨道待重新关联' && event.data.sourceKind === 'library' && event.data.reason === 'missing' && event.data.error.includes('已失效')));
  // Rename changes ctime/version on some filesystems, so local reattachment
  // below uses the exact saved fingerprint instead of silently accepting a new server version.
  await rename(clip + '.offline', clip);
  const local = structuredClone(snapshot); delete local.media.find(m => m.id === local.tracks[0].mediaId).source;
  await page.evaluate(document => { window.pendingImport = window.voidPlayer.importWorkspace(document); }, local);
  await page.getByRole('button', { name: '稍后关联', exact: true }).click(); await page.evaluate(() => window.pendingImport);
  assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks[0].pendingRelink, true);
  assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().marks), snapshot.marks);
  const localContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    await localContext.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }));
    const localPage = await localContext.newPage(); localPage.on('pageerror', error => errors.push(error.message));
    await localPage.goto(base); await localPage.waitForFunction(() => window.voidPlayer);
    const localDocument = structuredClone(snapshot); for (const info of localDocument.media) delete info.source;
    const importing = localPage.evaluate(document => window.voidPlayer.tools.find(tool => tool.name === 'import_workspace').execute({ document }), localDocument);
    await localPage.locator('.workspace-relink').waitFor();
    assert.match(await localPage.locator('.workspace-relink').textContent(), /当前浏览器不支持保存本地文件访问权限/);
    await localPage.getByRole('button', { name: '稍后关联', exact: true }).click(); await importing;
    await localPage.locator('.toast').filter({ hasText: '当前浏览器不支持保存本地文件访问权限' }).waitFor();
    const state = await localPage.evaluate(() => window.voidPlayer.getState());
    assert.equal(state.tracks[0].pendingRelink, true); assert.equal(state.tracks[0].frame, null);
    assert.deepEqual(state.marks, localDocument.marks);
    await localPage.screenshot({ path: path.resolve('artifacts/source-activity/local-workspace-unsupported.png') });
  } finally { await localContext.close(); }
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: stable checkpoint reload, history restore/export/confirmed deletion, explicit recovery, comparison restoration, missing source/marks/offset retention, deferred local relink`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await library.close(); await rm(directory, { recursive: true, force: true }); }
