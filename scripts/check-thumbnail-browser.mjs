// Phase-1 thumbnail proof: opening an SDR library video from its origin
// produces a row cover and a shared server cache; a fresh profile reuses the
// server image without regenerating; a non-zero join stays imageless.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';
import { THUMB_RECIPE_VERSION } from '../src/thumbnails/contract.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-thumb-ui-'));
const media = path.join(directory, 'archive');
await mkdir(media, { recursive: true });
await copyFile('fixtures/video/h264_9s_1920x1080.mp4', path.join(media, 'sample.mp4'));
await copyFile('fixtures/video/h264_9s_1920x1080.mp4', path.join(media, 'sample-late.mp4'));
const library = new MediaLibraryIndex([{ id: 'archive', path: media, name: '项目归档' }]);
await library.refresh();
const server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const engine = process.argv[2] ?? 'webkit';
const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });

const thumbReady = (name) => {
  const row = [...document.querySelectorAll('#source-list .source-row')].find(r => r.textContent.includes(name));
  const img = row?.querySelector('.source-thumb img');
  return !!img && img.complete && img.naturalWidth > 0;
};

async function openSamples(page) {
  await page.goto(base);
  await page.waitForFunction(() => window.voidPlayer);
  await page.locator('#toggle-sources').click();
  await page.locator('#library-root').click();
  await page.locator('#library-root-menu').getByRole('menuitemradio', { name: '项目归档', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#source-list')?.textContent.includes('sample.mp4'));
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await openSamples(page);
  // No cover and no empty slot before anything is opened.
  assert.equal(await page.evaluate(() => !!document.querySelector('.source-thumb img[src]')), false);
  assert.equal(await page.evaluate(() => !!document.querySelector('.source-thumb')), false);
  await page.locator('#source-list').getByRole('button', { name: '添加到视图：sample.mp4', exact: true }).click();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy);
  // The first frame is up before the cover pipeline finishes.
  const frame = await page.evaluate(() => window.voidPlayer.getState().tracks[0].frame);
  assert.ok(frame && frame.ptsUs === 0, 'origin frame presented');
  await page.waitForFunction(thumbReady, 'sample.mp4', { timeout: 20000 });
  const cover = await page.evaluate((name) => {
    const img = [...document.querySelectorAll('#source-list .source-row')].find(r => r.textContent.includes(name))?.querySelector('.source-thumb img');
    return img ? { src: img.currentSrc || img.src, naturalWidth: img.naturalWidth, complete: img.complete } : null;
  }, 'sample.mp4');
  assert.ok(cover && cover.complete && cover.naturalWidth > 0, `cover decoded: ${JSON.stringify(cover)}`);
  // Shared server cache arrives via the frozen-epoch upload.
  const entry = library.browse().entries.find(e => e.name === 'sample.mp4');
  const statusUrl = `${base}/api/media/${entry.id}/thumbnail-status?v=${entry.version}&recipe=${encodeURIComponent(THUMB_RECIPE_VERSION)}`;
  let status = null;
  for (let i = 0; i < 40 && (!status || status.state !== 'ready'); i++) {
    await new Promise(r => setTimeout(r, 500));
    status = await (await fetch(statusUrl)).json();
  }
  assert.equal(status.state, 'ready');
  assert.ok(status.width > 0 && status.height > 0);
  // Playback still works after the bypass ran.
  await page.evaluate(() => window.voidPlayer.seek(3000000));
  await page.waitForFunction(() => !window.voidPlayer.getState().busy);
  // Joining a second file at a non-zero position stays imageless: no cover
  // seek, no sync-frame snapshot.
  await page.locator('#source-list').getByRole('button', { name: '添加到视图：sample-late.mp4', exact: true }).click();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 2 && !window.voidPlayer.getState().busy);
  await new Promise(r => setTimeout(r, 3000));
  const late = await page.evaluate(() => [...document.querySelectorAll('#source-list .source-row')]
    .find(r => r.textContent.includes('sample-late.mp4'))?.querySelector('.source-thumb img[src]') ?? null);
  assert.equal(late, null, 'non-zero join must not snapshot the sync frame');
  await context.close();

  // A fresh profile (empty local cache) reuses the server image directly.
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await fresh.newPage();
  page2.on('pageerror', e => errors.push(e.message));
  const reuseVideoRequests = [];
  page2.on('request', request => { if (request.headers().range || /\/api\/media\/[0-9a-f]{24}(?:\?|$)/.test(request.url())) reuseVideoRequests.push(request.url()); });
  await openSamples(page2);
  await page2.waitForFunction(thumbReady, 'sample.mp4', { timeout: 20000 });
  const reused = await page2.evaluate(() => [...document.querySelectorAll('#source-list .source-row')]
    .find(r => r.textContent.includes('sample.mp4'))?.querySelector('.source-thumb img')?.src);
  assert.match(reused, /\/api\/media\/[0-9a-f]{24}\/thumbnail\?/, 'fresh profile loads the shared image');
  assert.deepEqual(reuseVideoRequests, [], 'cached covers never reopen or read videos');
  await fresh.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: origin open generates and shares a first-frame cover, fresh profiles reuse it, non-zero joins stay imageless`);
} finally {
  await browser.close(); await new Promise(r => server.close(r)); await library.close(); await rm(directory, { recursive: true, force: true });
}
