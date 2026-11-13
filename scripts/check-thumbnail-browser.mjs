// Phase-1 thumbnail proof: opening an SDR library video from its origin
// produces a row cover and a shared server cache; a fresh profile reuses the
// server image without regenerating; a non-zero join stays imageless.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from './testing/browser-engines.mjs';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';
import { THUMB_RECIPE_VERSION } from '../shared/thumbnails/contract.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-thumb-ui-'));
const media = path.join(directory, 'archive');
await mkdir(media, { recursive: true });
await mkdir(path.join(media,'empty'));
await copyFile('fixtures/video/h264_9s_1920x1080.mp4', path.join(media, 'sample.mp4'));
await copyFile('fixtures/video/h264_9s_1920x1080.mp4', path.join(media, 'sample-late.mp4'));
const library = new MediaLibraryIndex([{ id: 'archive', path: media, name: '项目归档' }]);
await library.refresh();
const server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const engine = process.argv[2] ?? 'webkit';
const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true, ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });

const thumbReady = (name) => {
  const row = [...document.querySelectorAll('#source-list .source-row')].find(r => r.textContent.includes(name));
  const img = row?.querySelector('.source-thumb img');
  return !!img && img.complete && img.naturalWidth > 0 && img.dataset.thumbDecoded === 'true' && getComputedStyle(img).visibility === 'visible';
};

async function openSamples(page) {
  await page.goto(base);
  await page.waitForFunction(() => window.voidPlayer);
  await page.locator('#toggle-sources').click();
  await page.getByRole('button', {name:'打开媒体库：项目归档',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#source-list')?.textContent.includes('sample.mp4'));
}

try {
  // A direct/Agent open has never browsed the media directory. It must still
  // publish the first frame for B, who is already viewing a missing cover.
  const readerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const writerContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const reader = await readerContext.newPage(), writer = await writerContext.newPage();
  await openSamples(reader);
  const direct = library.browse().entries.find(entry => entry.name === 'sample-late.mp4');
  const recentReader = await readerContext.newPage();
  await recentReader.addInitScript(entry => localStorage.setItem('voidplayer.sources.v1', JSON.stringify([{
    name: entry.name, size: entry.size, lastModified: entry.lastModified, version: entry.version,
    libraryId: entry.id, libraryRootId: entry.rootId, openedAt: Date.now(),
  }])), direct);
  await recentReader.goto(base); await recentReader.waitForFunction(() => window.voidPlayer);
  await recentReader.locator('#toggle-sources').click();
  await recentReader.waitForFunction(() => document.querySelector('#library-recents')?.textContent.includes('sample-late.mp4'));
  assert.equal(await recentReader.evaluate(() => !!document.querySelector('#library-recents .source-thumb img[src]')), false);
  await writer.goto(base); await writer.waitForFunction(() => window.voidPlayer);
  const uploaded = writer.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/thumbnail'), { timeout: 20000 });
  await writer.evaluate(id => window.voidPlayer.tools.find(tool => tool.name === 'load_library_item').execute({ slot: 'A', id }), direct.id);
  assert.equal((await uploaded).status(), 201, 'direct opens warm the upload epoch from their existing metadata request');
  await reader.bringToFront();
  await reader.waitForFunction(thumbReady, 'sample-late.mp4', { timeout: 20000 });
  await recentReader.bringToFront();
  await recentReader.waitForFunction(thumbReady, 'sample-late.mp4', { timeout: 20000 });
  assert.equal(await recentReader.evaluate(() => window.voidPlayer.getState().tracks.length), 0, 'recent entries discover remote uploads without loading media');
  assert.equal(await reader.evaluate(() => window.voidPlayer.getState().tracks.length), 0, 'reader receives a shared cover without opening media');
  assert.equal(library.thumbnails.status(direct.id, direct.version, THUMB_RECIPE_VERSION).ready, true);
  await readerContext.close(); await writerContext.close();
  library.thumbnails.remove(); // Original generation and cache-clear cases start empty.
  const uriContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  const uriPage = await uriContext.newPage();
  const uriUpload = uriPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/thumbnail'), { timeout: 20000 });
  await uriPage.goto(`${base}/?abi=1&A=${direct.id}@${direct.version}`);
  assert.equal((await uriUpload).status(), 201, 'cold URI restoration offers its committed origin frame to the shared cache');
  await uriContext.close(); library.thumbnails.remove();
  const context = await browser.newContext({locale:'zh-CN',  viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await openSamples(page);
  // No cover and no empty slot before anything is opened.
  assert.equal(await page.evaluate(() => !!document.querySelector('.source-thumb img[src]')), false);
  assert.equal(await page.evaluate(() => !!document.querySelector('.source-file .source-thumb')), false);
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
  // Track-state changes must keep the already decoded image through row refreshes.
  const directoryCover=await page.locator('#source-list .source-file .source-thumb img').elementHandle();
  await directoryCover.evaluate(img => {
    window.stableCover=img; window.coverGaps=[]; window.coverWatch=true;
    const sample=() => {
      if(!window.coverWatch)return;
      const row=[...document.querySelectorAll('#source-list .source-file')].find(row => row.querySelector('.filename')?.textContent==='sample.mp4');
      const current=row?.querySelector('.source-thumb img');
      if(current!==img||!img.complete||!img.naturalWidth||img.dataset.thumbDecoded!=='true'||getComputedStyle(img).visibility!=='visible')window.coverGaps.push({same:current===img,connected:img.isConnected,visible:getComputedStyle(img).visibility});
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const sampleRow=page.locator('#source-list .source-file').filter({has:page.locator('.filename',{hasText:'sample.mp4'})});
  const assertRetained=async label => {
    assert.equal(await sampleRow.locator('.source-thumb img').evaluate(img => img===window.stableCover),true,label);
    assert.equal(await page.evaluate(thumbReady,'sample.mp4'),true,'a retained cover is ready immediately');
    assert.deepEqual(await page.evaluate(() => window.coverGaps),[],'no animation frame loses the decoded cover');
  };
  await sampleRow.hover(); await sampleRow.locator('.source-remove').click();
  await page.waitForFunction(() => !window.voidPlayer.getState().tracks.length);
  await assertRetained('button removal retains the decoded cover node');
  await sampleRow.locator('.source-open').click();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length===1&&!window.voidPlayer.getState().busy);
  await assertRetained('adding the source retains the same cover throughout loading');
  await sampleRow.click({button:'right'}); await page.locator('#library-file-menu [data-action=remove-from-view]').click();
  await page.waitForFunction(() => !window.voidPlayer.getState().tracks.length);
  await assertRetained('context-menu removal also retains the cover');
  await sampleRow.click({button:'right'}); await page.locator('#library-file-menu [data-action=add-to-view]').click();
  await page.waitForFunction(() => window.voidPlayer.getState().tracks.length===1&&!window.voidPlayer.getState().busy);
  await assertRetained('context-menu addition retains the cover');
  await page.evaluate(() => {window.coverWatch=false;});
  // Recent covers must survive details hiding and rapid summary activation.
  await page.locator('#library-location').fill('library:/'); await page.locator('#library-location').press('Enter');
  await page.waitForFunction(thumbReady, 'sample.mp4');
  const recent = page.locator('#library-recents'), summary = recent.locator('summary');
  const originalCover = await recent.locator('.source-thumb img').elementHandle();
  await originalCover.evaluate(img => {
    window.recentCoverWrites = [];
    window.recentCoverObserver = new MutationObserver(records => window.recentCoverWrites.push(...records.map(record => record.attributeName)));
    window.recentCoverObserver.observe(img, {attributes:true, attributeFilter:['src']});
  });
  await summary.click(); await page.waitForTimeout(150); await summary.click();
  await page.waitForFunction(thumbReady, 'sample.mp4', {timeout:5000});
  assert.deepEqual(await page.evaluate(() => window.recentCoverWrites), [], 'rapid folding retains the loaded image without clearing or reassigning its URL');
  const retainedSource = await originalCover.getAttribute('src');
  await summary.click(); await page.waitForTimeout(2500);
  assert.equal(await originalCover.getAttribute('src'), retainedSource, 'long folds retain the same loaded image too');
  assert.equal(await originalCover.evaluate(img => img.complete && img.naturalWidth > 0), true, 'hidden cover stays decoded');
  await summary.click();
  await page.waitForFunction(thumbReady, 'sample.mp4', {timeout:5000});
  assert.equal(await originalCover.evaluate(img => img.isConnected), true, 'folding keeps the original cover node');
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await summary.dblclick();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '', 'rapid summary clicks never select the heading or file text');
  await summary.click({clickCount:3});
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '', 'triple clicks cannot select the list paragraph');
  await recent.evaluate(group => {group.open=true;});
  await page.waitForFunction(thumbReady, 'sample.mp4');
  const foldWrites = await page.evaluate(() => {window.recentCoverObserver.disconnect();return window.recentCoverWrites;});
  assert.deepEqual(foldWrites, [], 'all fold gestures leave the existing image URL untouched');
  await page.getByRole('button', {name:'打开媒体库：项目归档',exact:true}).click();
  assert.equal(await originalCover.evaluate(img => img.isConnected),true,'returning to the same source in its directory keeps the decoded image');
  await page.getByRole('button',{name:'打开目录：empty',exact:true}).click();
  await page.waitForFunction(img => !img.isConnected && !img.getAttribute('src'), originalCover);
  await page.locator('.crumbs-back').click();
  await page.waitForFunction(thumbReady,'sample.mp4');
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
  const fresh = await browser.newContext({locale:'zh-CN',  viewport: { width: 1280, height: 800 } });
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
  // A real corrupt image must never paint the browser's broken-image icon.
  await page2.route('**/thumbnail?**', route => new URL(route.request().url()).searchParams.has('broken')
    ? route.fulfill({status:200, contentType:'image/jpeg', body:'invalid jpeg'}) : route.continue());
  const cachedImage = page2.locator('#source-list .source-file .source-thumb img');
  const slotBefore = await cachedImage.locator('..').boundingBox();
  await cachedImage.evaluate(img => {
    img.addEventListener('error', () => {window.failedCoverPaint = getComputedStyle(img).visibility;}, {once:true});
    img.src += '&broken=1';
  });
  await page2.waitForFunction(() => window.failedCoverPaint !== undefined);
  assert.equal(await page2.evaluate(() => window.failedCoverPaint), 'hidden', 'failed images are hidden before error fallback completes');
  assert.equal(await cachedImage.evaluate(img => getComputedStyle(img).visibility), 'hidden');
  assert.deepEqual(await cachedImage.locator('..').boundingBox(), slotBefore, 'failure preserves the cover slot and filename position');
  await fresh.close();
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine}: origin cover, continuous covers across add/remove actions, recent fold/reopen and rapid-click selection, shared cover reuse, invisible image errors, non-zero joins stay imageless`);
} finally {
  await browser.close(); await new Promise(r => server.close(r)); await library.close(); await rm(directory, { recursive: true, force: true });
}
