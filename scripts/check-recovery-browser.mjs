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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  await page.reload(); await page.waitForFunction(() => window.voidPlayer);
  assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks.length, 0, 'restoration is offered, not automatic');
  await page.getByRole('button', { name: '恢复工作区', exact: true }).click();
  await page.getByText('工作区已恢复。', { exact: true }).waitFor();
  let restored = await page.evaluate(() => window.voidPlayer.exportWorkspace());
  assert.deepEqual(restored.tracks, snapshot.tracks); assert.deepEqual(restored.marks, snapshot.marks);
  assert.deepEqual(restored.comparison, snapshot.comparison); assert.equal(restored.positionUs, snapshot.positionUs);
  // Make the remote source temporarily unavailable and repeat a user-directed restore.
  await rename(clip, clip + '.offline');
  await page.evaluate(document => window.voidPlayer.importWorkspace(document), snapshot);
  let state = await page.evaluate(() => window.voidPlayer.getState());
  assert.equal(state.tracks[0].pendingRelink, true); assert.equal(state.tracks[0].frame, null);
  assert.deepEqual(state.marks, snapshot.marks); assert.equal(state.tracks[0].offsetUs, 100000);
  assert.equal(await page.locator('#image-A').isVisible(), false, 'missing track must not show the previous review frame');
  // Rename changes ctime/version on some filesystems, so local reattachment
  // below uses the exact saved fingerprint instead of silently accepting a new server version.
  await rename(clip + '.offline', clip);
  const local = structuredClone(snapshot); delete local.media.find(m => m.id === local.tracks[0].mediaId).source;
  await page.evaluate(document => { window.pendingImport = window.voidPlayer.importWorkspace(document); }, local);
  await page.getByRole('button', { name: '稍后关联', exact: true }).click(); await page.evaluate(() => window.pendingImport);
  assert.equal((await page.evaluate(() => window.voidPlayer.getState())).tracks[0].pendingRelink, true);
  assert.deepEqual(await page.evaluate(() => window.voidPlayer.getState().marks), snapshot.marks);
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: checkpoint commit/reload, explicit recovery, comparison restoration, missing source/marks/offset retention, deferred local relink`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await library.close(); await rm(directory, { recursive: true, force: true }); }
