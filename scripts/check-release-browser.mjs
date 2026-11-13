import { chooseTestGuest } from './test-identity.mjs';
// Browser acceptance against an extracted native release; never serves source/dist.
// Usage: node scripts/check-release-browser.mjs [/path/to/package.tar.gz|-] [webkit|chromium] [--version-only]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { webkit, chromium } from './testing/browser-engines.mjs';
import { sha256 } from './check-release-set.mjs';
import { generatedLibrary } from './check-generated-library.mjs';
const root = path.resolve(import.meta.dirname, '..');
const versionOnly = process.argv.includes('--version-only');
const args = process.argv.slice(2).filter(arg => arg !== '--version-only');
const archive = path.resolve((args[0] !== '-' && args[0]) || JSON.parse(await readFile(path.join(root, 'artifacts/latest-release.json'), 'utf8')).archive);
const browserName = args[1] || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
const samples = path.resolve(process.env.VOIDPLAYER_SAMPLES || path.join(root, 'fixtures/video'));
const generated = !versionOnly && process.env.VOIDPLAYER_LIBRARY_FIXTURE ? await generatedLibrary(process.env.VOIDPLAYER_LIBRARY_FIXTURE) : null;
if (!versionOnly && !generated) for (const file of ['av1_10s_1920x1080.webm', 'ffv1_yuv444p10le.mkv']) await access(path.join(samples, file));
const temp = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-native-browser-'));
let child, browser, output = '';
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || key.startsWith('VOIDPLAYER_') || ['BUN_OPTIONS', 'BUN_INSPECT'].includes(key)) delete env[key];
env.PATH = path.join(temp, 'empty-path');
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'close'), processToStop = child;
  processToStop.kill('SIGTERM');
  const timer = setTimeout(() => processToStop.kill('SIGKILL'), 8000);
  try { const [code, signal] = await done; assert.ok(code === 0 || process.platform === 'win32' && signal === 'SIGTERM', output); }
  finally { clearTimeout(timer); child = null; }
}
try {
  const bytes = await readFile(archive);
  assert.equal((await readFile(archive + '.sha256', 'utf8')).trim(), `${sha256(bytes)}  ${path.basename(archive)}`);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', temp]);
  const directory = path.join(temp, path.basename(archive, '.tar.gz'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  assert.equal(manifest.target, `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`);
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(sha256(await readFile(path.join(directory, file))), digest, file);
  const executable = path.join(directory, manifest.executable), data = path.join(temp, 'data'), cwd = path.join(temp, 'unrelated-cwd');
  await mkdir(data); await mkdir(cwd); await mkdir(env.PATH);
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  await writeFile(path.join(data, 'voidplayer.config.json'), JSON.stringify({ host: '127.0.0.1', port, mediaRoots: versionOnly ? [] : generated?.roots || [{ id: 'qa', name: 'QA', path: samples }], logsDir: null, indexWatch: false }));
  async function start() {
    output = '';
    child = spawn(executable, ['--data-dir', data], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(output);
      if (await fetch(base + '/api/ready', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) { ready = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready, output || 'native startup timeout');
    const status = await (await fetch(base + '/api/admin/status')).json();
    assert.equal(status.version, manifest.appVersion);
    assert.equal(sha256(Buffer.from(await (await fetch(base + '/')).arrayBuffer())), manifest.files['dist/index.html'], 'serves exactly the packaged frontend');
  }
  await start();
  const generatedEntries = await generated?.verify(base);
  browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({locale:'zh-CN',  viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = []; context.on('page', p => { p.setDefaultTimeout(30000); p.on('pageerror', e => errors.push(e.message)); });
  const page = await context.newPage(); await page.goto(base);await chooseTestGuest(page);
  assert.equal(await page.locator('.start-version, #start-version-about').count(), 0, 'start screen has no permanent version footer');
  for (const entry of ['#brand-about']) {
    await page.locator(entry).click();
    await page.locator('#settings-pane-about').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#about-version').innerText(), manifest.appVersion, 'About shows the packaged semantic version');
    await page.locator('#settings-close').click();
    await page.locator('#settings').waitFor({ state: 'hidden' });
  }
  if (!versionOnly) {
  const call = (p, name, args = {}) => p.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
  // Decoded tracks commit before asynchronous annotation/layout restoration.
  const waitForWorkspace = async (p, expected) => {
   try { await p.waitForFunction(expected => {
    const actual = window.voidPlayer?.exportState();
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return actual && ['tracks', 'positionUs', 'viewport', 'layout', 'comparison'].every(key => JSON.stringify(canonical(actual[key])) === JSON.stringify(canonical(expected[key])));
   }, expected); }
   catch (error) {
    const actual = await call(p, 'get_uri_state');
    for (const key of ['tracks', 'positionUs', 'viewport', 'layout', 'comparison']) assert.deepEqual(actual[key], expected[key], `restore ${key}`);
    throw error;
   }
  };
  await page.waitForFunction(() => window.voidPlayer);
  if (generated) {
    await page.locator('#toggle-sources').click();
    await page.getByRole('button', {name:'打开媒体库：项目归档',exact:true}).click();
    await page.getByRole('button', { name: '打开目录：分页目录', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 60);
    await page.locator('#source-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
    for (let attempt = 0; attempt < 20 && !await page.locator('#source-list').evaluate(el => el.textContent.includes('clip-00180')); attempt++) { await page.locator('#source-list').evaluate(el => { el.scrollTop = el.scrollHeight; }); await page.waitForTimeout(150); }
    assert.ok(await page.locator('#source-list').evaluate(el => el.textContent.includes('clip-00180')), 'scrolling reaches later items without page controls');
    await page.locator('#library-location').fill('clip-00777');
    await page.waitForFunction(() => document.querySelectorAll('#source-list .source-file').length === 1);
    await page.locator('#source-list').getByRole('button', { name: '添加到视图：分页目录/clip-00777.mp4', exact: true }).click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy);
    console.log('PASS generated library UI: root selection, directory navigation, continuous scrolling, scoped search and load from last page');
  }
  const entries = generatedEntries || (await call(page, 'list_library')).entries;
  const playback = generated?.playback || [{ slot: 'A', name: 'av1_10s_1920x1080.webm' }, { slot: 'B', name: 'ffv1_yuv444p10le.mkv' }];
  for (const { slot, name, rootId } of playback) {
    const entry = entries.find(e => e.name === name && (!rootId || e.rootId === rootId)); assert.ok(entry, name);
    await call(page, 'load_library_item', { slot, id: entry.id });
  }
  const state = await page.evaluate(() => window.voidPlayer.getState());
  assert.equal(state.tracks.length, 2);
  await call(page, 'set_review_track_offset', { slot: 'B', offsetUs: 300000 });
  await call(page, 'seek_review', { ptsUs: 1000000 });
  await call(page, 'add_review_mark', { slot: 'A', text: 'Native release round trip', drawings: [{ id: 'rect', tool: 'rect', color: '#ff3b30', strokeWidth: 4, points: [{ x: .2, y: .2 }, { x: .6, y: .5 }] }] });
  await page.evaluate(() => window.voidPlayer.setViewport({ mode: 'split', splitPos: .37, zoom: 1.5 }));
  const saved = await call(page, 'get_uri_state');
  const savedMarks = (await call(page, 'get_review_session')).marks; assert.equal(savedMarks.length, 1); assert.equal(saved.viewport.mode, 'split');
  assert.equal(saved.viewport.zoom, 1.5); assert.ok(saved.layout);
  const shared = await call(page, 'share_state'); assert.ok(new URL(shared.url).searchParams.has('s'));
  const admin = await context.newPage(); await admin.goto(base + '/admin');
  await admin.getByRole('button', { name: '标注', exact: true }).click();
  await admin.locator('#admin-annotation-list button').filter({ hasText: 'Native release round trip' }).waitFor();
  const restored = await context.newPage(); restored.on('pageerror', e => errors.push(e.message)); await restored.goto(shared.url);
  await restored.waitForFunction(() => window.voidPlayer); await chooseTestGuest(restored);
  await restored.waitForFunction(() => window.voidPlayer.getState().tracks.length === 2 && !window.voidPlayer.getState().busy);
  await waitForWorkspace(restored, saved);
  await restored.waitForFunction(id => window.voidPlayer.getState().marks.some(mark => mark.id === id), savedMarks[0].id);
  await context.close();
  await generated?.disconnect();
  await stop(); await start();
  if (generated) {
    await generated.verifyOffline();
    assert.equal((await fetch(base + '/api/uri/decode?s=' + new URL(shared.url).searchParams.get('s'))).status, 200);
    await generated.reconnect();
  }
  const restarted = await browser.newPage({locale:'zh-CN'}); restarted.on('pageerror', e => errors.push(e.message));
  await restarted.goto(shared.url);
  await chooseTestGuest(restarted);
  await restarted.waitForFunction(() => window.voidPlayer?.getState().tracks.length === 2 && window.voidPlayer.getState().marks.length === 1 && !window.voidPlayer.getState().busy);
  await waitForWorkspace(restarted, saved);
  const reopened = await call(restarted, 'get_uri_state');
  for (const key of ['tracks', 'positionUs', 'viewport', 'layout', 'comparison']) assert.deepEqual(reopened[key], saved[key], `restart ${key}`);
  assert.deepEqual(errors, []);
  console.log(`PASS native ${manifest.appVersion} ${manifest.revision} ${browserName}: packaged frontend, dual decode, vector marks, ABI state restore, source annotation/admin inspection and process restart; empty PATH and isolated data`);
  } else {
    assert.deepEqual(errors, []);
    console.log(`PASS native ${manifest.appVersion} ${manifest.revision} ${browserName}: packaged start/About version equals server/manifest; empty PATH and unrelated cwd`);
  }
  await browser.close(); browser = null;
  await generated?.replacement();
  if (!versionOnly && process.env.RELEASE_BENCH === '1') {
    const bench = spawn(process.execPath, [path.join(root, 'scripts/bench-playback.mjs'), browserName, '--headless'], { cwd: root, env: { ...process.env, BASE_URL: base, BENCH_REPEATS: process.env.BENCH_REPEATS || '1' }, stdio: 'inherit' });
    const timer = setTimeout(() => bench.kill('SIGKILL'), 600000);
    try { const [code] = await once(bench, 'close'); assert.equal(code, 0, 'packaged playback benchmark'); } finally { clearTimeout(timer); }
  }
} finally { await browser?.close(); try { await stop(); } finally { await generated?.cleanup(); await rm(temp, { recursive: true, force: true }); } }
