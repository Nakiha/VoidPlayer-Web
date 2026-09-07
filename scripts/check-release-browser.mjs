// Browser acceptance against an extracted native release; never serves source/dist.
// Usage: node scripts/check-release-browser.mjs /path/to/package.tar.gz [webkit|chromium]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { sha256 } from './check-release-set.mjs';
import { generatedLibrary } from './check-generated-library.mjs';
const root = path.resolve(import.meta.dirname, '..');
const archive = path.resolve(process.argv[2] || JSON.parse(await readFile(path.join(root, 'artifacts/latest-release.json'), 'utf8')).archive);
const browserName = process.argv[3] || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
const samples = path.resolve(process.env.VOIDPLAYER_SAMPLES || path.join(root, 'fixtures/video'));
const generated = process.env.VOIDPLAYER_LIBRARY_FIXTURE ? await generatedLibrary(process.env.VOIDPLAYER_LIBRARY_FIXTURE) : null;
if (!generated) for (const file of ['av1_10s_1920x1080.webm', 'ffv1_yuv444p10le.mkv']) await access(path.join(samples, file));
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
  await writeFile(path.join(data, 'voidplayer.config.json'), JSON.stringify({ host: '127.0.0.1', port, mediaRoots: generated?.roots || [{ id: 'qa', name: 'QA', path: samples }], logsDir: null, indexWatch: false }));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = []; context.on('page', p => { p.setDefaultTimeout(30000); p.on('pageerror', e => errors.push(e.message)); });
  const page = await context.newPage(); await page.goto(base);
  const call = (p, name, args = {}) => p.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
  await page.waitForFunction(() => window.voidPlayer);
  if (generated) {
    await page.locator('#toggle-sources').click();
    await page.locator('#library-root').selectOption('archive');
    await page.getByRole('button', { name: '打开目录：分页目录', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#source-list .source-actions').length === 60);
    await page.getByRole('button', { name: '下一页片源', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#source-list').textContent.includes('clip-00180'));
    await page.locator('#source-search').fill('clip-00777');
    await page.waitForFunction(() => document.querySelectorAll('#source-list .source-actions').length === 1);
    await page.locator('#source-list').getByRole('button', { name: '添加到视图：分页目录/clip-00777.mp4', exact: true }).click();
    await page.waitForFunction(() => window.voidPlayer.getState().tracks.length === 1 && !window.voidPlayer.getState().busy);
    console.log('PASS generated library UI: root selection, directory navigation, 60-item pagination, scoped search and load from last page');
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
  const saved = await call(page, 'export_workspace');
  assert.equal(saved.marks.length, 1); assert.equal(saved.viewport.mode, 'split');
  assert.equal(saved.viewport.zoom, 1.5); assert.ok(saved.layout);
  await page.locator('#settings-open').click(); await page.locator('#settings-tab-workspace').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
  const document = await readFile(await download.path()); assert.deepEqual(JSON.parse(gunzipSync(document)).marks, saved.marks);
  await page.locator('#saved-workspace-name').fill('Native release'); await page.locator('#saved-workspace-save').click();
  await page.locator('#saved-workspace-message').filter({ hasText: '已保存到服务器' }).waitFor();
  const stored = (await (await fetch(base + '/api/workspaces')).json()).entries[0]; assert.equal(stored.revision, 1);
  const restored = await context.newPage(); await restored.goto(base);
  await restored.locator('#workspace-file').setInputFiles({ name: 'review.voidplayer', mimeType: 'application/gzip', buffer: document });
  await restored.waitForFunction(() => window.voidPlayer.getState().tracks.length === 2 && !window.voidPlayer.getState().busy);
  const imported = await call(restored, 'export_workspace');
  for (const key of ['marks', 'tracks', 'positionUs', 'viewport', 'layout']) assert.deepEqual(imported[key], saved[key], key);
  const admin = await context.newPage(); await admin.goto(base + '/admin');
  await admin.getByRole('button', { name: '工作区', exact: true }).click();
  await admin.locator('#admin-workspaces-list button').filter({ hasText: 'Native release' }).click();
  await admin.waitForFunction(() => document.querySelector('#admin-workspace-json').value.includes('Native release round trip'));
  await context.close();
  await generated?.disconnect();
  await stop(); await start();
  if (generated) {
    await generated.verifyOffline();
    assert.equal((await (await fetch(base + '/api/workspaces')).json()).entries[0].id, stored.id);
    await generated.reconnect();
  }
  const restarted = await browser.newPage(); restarted.on('pageerror', e => errors.push(e.message));
  await restarted.goto(base + '/?workspace=' + stored.id);
  await restarted.waitForFunction(() => window.voidPlayer?.getState().tracks.length === 2 && window.voidPlayer.getState().marks.length === 1 && !window.voidPlayer.getState().busy);
  const reopened = await call(restarted, 'export_workspace');
  for (const key of ['marks', 'tracks', 'positionUs', 'viewport', 'layout']) assert.deepEqual(reopened[key], saved[key], `restart ${key}`);
  assert.deepEqual(errors, []);
  console.log(`PASS native ${manifest.appVersion} ${manifest.revision} ${browserName}: packaged frontend, dual decode, vector marks, gzip file restore, server save/admin inspection, process restart and workspace restore; empty PATH and isolated data`);
  await browser.close(); browser = null;
  await generated?.replacement();
  if (process.env.RELEASE_BENCH === '1') {
    const bench = spawn(process.execPath, [path.join(root, 'scripts/bench-playback.mjs'), browserName, '--headless'], { cwd: root, env: { ...process.env, BASE_URL: base, BENCH_REPEATS: process.env.BENCH_REPEATS || '1' }, stdio: 'inherit' });
    const timer = setTimeout(() => bench.kill('SIGKILL'), 600000);
    try { const [code] = await once(bench, 'close'); assert.equal(code, 0, 'packaged playback benchmark'); } finally { clearTimeout(timer); }
  }
} finally { await browser?.close(); try { await stop(); } finally { await generated?.cleanup(); await rm(temp, { recursive: true, force: true }); } }
