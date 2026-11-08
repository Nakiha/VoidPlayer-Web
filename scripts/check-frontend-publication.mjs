import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from './testing/browser-engines.mjs';
import { build } from 'vite';
import { loadConfig } from '../server/config.ts';
import { publishFrontend } from '../server/frontend-releases.ts';
import { startPublishedService } from '../server/runtime.ts';
import { chooseTestGuest } from './test-identity.mjs';
import { withinBrowserPhase } from './browser-failure-evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'vp-frontend-publication-'));
const a = path.join(root, 'dist'), candidate = path.join(temporary, 'candidate'), publicDir = path.join(temporary, 'public');
const store = path.join(temporary, 'data/frontend-releases');
const info = async directory => JSON.parse(await readFile(path.join(directory, 'build-info.json'), 'utf8'));
const pages = [], contexts = [];
let service, browser;
try {
  const media = path.join(root, 'fixtures/video');
  const config = await loadConfig(['--static', a, '--data-dir', path.join(temporary, 'data'), '--folder', media], 'production');
  config.port = 0; config.logsDir = null;
  service = await startPublishedService(config);
  const base = 'http://127.0.0.1:' + service.server.address().port;
  const buildA = await info(a);
  browser = await chromium.launch();
  const plain = await browser.newContext();
  const app = await chromium.launchPersistentContext(path.join(temporary, 'app-profile'), { channel: 'chromium', args: ['--app=' + base] });
  contexts.push(plain, app);
  for (const [context, standalone] of [[plain, false], [app, true]]) {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(base); await chooseTestGuest(page);
    assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), standalone);
    if (standalone) {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    } else assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)), false);
    if (!await page.locator('#library-location').isVisible()) await page.locator('#toggle-sources').click();
    await page.locator('#library-mounts .library-mount').first().click();
    await page.locator('#source-list .source-file').filter({ hasText:'ci_h264_smoke.mp4' }).getByRole('button').first().click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.frame);
    await page.evaluate(async () => {
      const call = (name, args) => window.voidPlayer.tools.find(t => t.name === name).execute(args);
      await call('seek_review', {ptsUs:200000});
      await call('add_review_mark', {slot:'A', text:'A → B → C', drawings:[{id:'keep-area', tool:'rect', color:'#ff3b30',
        strokeWidth:4, points:[{x:.2,y:.2},{x:.6,y:.5}]}]});
      window.publicationDocument = 'original';
    });
    const snapshot = () => page.evaluate(() => {
      const { positionUs, marks, tracks } = window.voidPlayer.getState();
      return { positionUs, marks, firstFrame:tracks[0].frame, id:tracks[0].id, document:window.publicationDocument };
    });
    const before = await snapshot();
    assert.ok(before.positionUs > 0 && before.marks.length === 1 && before.marks[0].drawings.length === 1);
    pages.push({ page, standalone, snapshot, before });
  }

  await cp(path.join(root, 'public'), publicDir, { recursive:true });
  const corePath = '/vendor/voidplayer-core/voidplayer-core.wasm';
  for (const label of ['B', 'C']) {
    // An inert, valid WebAssembly custom section makes the core bytes genuinely distinct.
    for (const name of [corePath, corePath.replace('.wasm', '-mt.wasm')]) {
      await appendFile(path.join(publicDir, name), Buffer.from([0, 2, 1, label.charCodeAt(0)]));
    }
    await build({ root, publicDir, logLevel:'error', build:{outDir:candidate, emptyOutDir:true} });
    const next = await info(candidate);
    assert.notEqual(next.coreAssetDigests[corePath], buildA.coreAssetDigests[corePath]);
    await publishFrontend(candidate, store);
    assert.equal((await (await fetch(base + '/build-info.json')).json()).buildId, next.buildId);
    const fresh = await plain.newPage();
    await fresh.goto(base); await fresh.waitForFunction(() => !!window.voidPlayer);
    const nextHtml = await readFile(path.join(candidate, 'index.html'), 'utf8');
    assert.ok(nextHtml.includes(await fresh.locator('script[type=module][src]').first().getAttribute('src')));
    await fresh.close();
    await pages[1].page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await pages[1].page.waitForFunction(async () => { const reg = await navigator.serviceWorker.ready; return !reg.installing && reg.waiting?.state === 'installed'; });
    for (const lane of pages) assert.deepEqual(await lane.snapshot(), lane.before, label + ': publishing interrupted the old document');
    for (const {page} of pages) {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('#server-update:visible').waitFor();
      await page.locator('.toast-warning').filter({ hasText:/后端已发布新版|server has published an update/ }).waitFor();
    }
    console.log('Published', label, next.buildId);
  }

  const coreURL = corePath + '?v=' + buildA.coreAssetDigests[corePath];
  assert.deepEqual(Buffer.from(await (await fetch(base + coreURL)).arrayBuffer()), await readFile(path.join(a, corePath)));
  const catalog = JSON.parse(await readFile(path.join(a, 'frontend-release.json'), 'utf8'));
  const latest = JSON.parse(await readFile(path.join(candidate, 'frontend-release.json'), 'utf8'));
  const lazy = Object.keys(catalog.files).find(name => /^assets\/js-container-media-.*\.js$/.test(name));
  assert.ok(lazy && !latest.files[lazy], 'A-only lazy container module must actually differ from C');
  for (const lane of pages) {
    const {page, standalone} = lane;
    const requests = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/' + lazy) requests.push(response); });
    await page.locator('#file-B').setInputFiles(path.join(media, 'ffv1_yuv422p_8bit.mkv'));
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.find(t => t.slot === 'B')?.frame);
    assert.ok(requests.some(response => response.ok() && response.fromServiceWorker() === standalone), 'late A module came from the expected release');
    const workers = page.workers().map(w => new URL(w.url()).pathname.slice(1));
    assert.ok(workers.some(name => /packet-worker-/.test(name) && catalog.files[name] && !latest.files[name]), 'loaded the A packet Worker');
    assert.equal(await page.evaluate(() => window.voidPlayer.getState().tracks.find(t => t.slot === 'B').decoder), 'ffmpeg-wasm');
    assert.deepEqual(await lane.snapshot(), lane.before, 'late FFV1 load changed the A frame, position, annotations or document');
    console.log('PASS', standalone ? 'standalone PWA' : 'ordinary tab', lane.before.positionUs, 'µs; A lazy module:', lazy);
  }
  // A raw file input has no persistent handle. Only switch after all remaining media can be reopened.
  const sibling = await app.newPage();
  await sibling.goto(base);
  await sibling.waitForFunction(() => !!window.voidPlayer);
  const siblingEntry = await sibling.locator('script[type=module][src]').first().getAttribute('src');
  await sibling.evaluate(() => { window.siblingDocument = 'A'; });
  for (const lane of pages) {
    const { page } = lane;
    await page.locator('#server-update').click();
    await page.locator('.toast-warning').filter({hasText:'ffv1_yuv422p_8bit.mkv'}).waitFor();
    assert.deepEqual(await lane.snapshot(), lane.before);
    await page.evaluate(() => window.voidPlayer.removeTrack('B'));
    const scene = () => page.evaluate(() => {
      const { generatedAt, thumbnails, media, ...document } = window.voidPlayer.exportWorkspace();
      // Reopening a source increments its diagnostic metadata revision.
      return { ...document, media: media.map(({ metadataRevision, ...info }) => info) };
    });
    const before = await scene();
    const action = lane.standalone ? page.locator('.toast-warning button').filter({hasText:/保存现场并刷新|Save this session and refresh/}).last() : page.locator('#server-update');
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}), action.click()]);
    await page.waitForFunction(() => window.voidPlayer?.getState().tracks[0]?.frame && !window.voidPlayer.getState().busy && !document.querySelector('[data-recovery-pending]'));
    await page.waitForFunction(layout => {
      const current = window.voidPlayer.getWorkspace();
      return Object.entries(layout.panels).every(([key, value]) => current.panels[key] === value)
        && Object.entries(layout.sources ?? {}).every(([key, value]) => current.sources?.[key] === value);
    }, before.layout);
    assert.deepEqual(await scene(), before, 'explicit update restores the review document');
    assert.ok((await readFile(path.join(candidate,'index.html'),'utf8')).includes(await page.locator('script[type=module][src]').first().getAttribute('src')));
    console.log('PASS explicit refresh:', lane.standalone ? 'PWA' : 'tab', before.positionUs, 'µs');
  }
  assert.equal(await sibling.evaluate(() => window.siblingDocument), 'A');
  assert.ok((await readFile(path.join(a,'index.html'),'utf8')).includes(siblingEntry), 'the sibling continues to run A');
  const newLazy = Object.keys(latest.files).find(name => /^assets\/js-container-media-.*\.js$/.test(name));
  await app.setOffline(true);
  try {
    assert.equal(await pages[1].page.evaluate(url => fetch(url, {cache:'no-store'}).then(r => r.ok), '/' + newLazy), true,
      'C assets remain available offline while the sibling keeps the A worker active');
  } finally { await app.setOffline(false); }
  await sibling.close();
  const monitor = await app.newCDPSession(pages[1].page);
  let waitingVersion;
  const activated = new Promise(resolve => monitor.on('ServiceWorker.workerVersionUpdated', ({versions}) => {
    for (const version of versions) {
      if (version.scriptURL === base + '/sw.js' && version.status === 'installed') waitingVersion = version.versionId;
      if (version.versionId === waitingVersion && version.status === 'activated') resolve();
    }
  }));
  await monitor.send('ServiceWorker.enable');
  // Release the final controlled document without opening a new A client
  // before C has naturally activated. Never force an update over a review.
  await pages[1].page.goto('about:blank');
  await withinBrowserPhase(() => activated, 15000, {engine:'chromium',caseName:'frontend-publication',phase:'natural worker activation'});
  await monitor.detach();
  await pages[1].page.close();
  const upgraded = await app.newPage();
  await upgraded.goto(base); await upgraded.waitForFunction(() => !!window.voidPlayer);
  assert.ok((await readFile(path.join(candidate,'index.html'),'utf8')).includes(await upgraded.locator('script[type=module][src]').first().getAttribute('src')),
    'the next PWA navigation uses C after A closes');
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser?.close(); await service?.close();
  await rm(temporary, {recursive:true, force:true});
}
