// Test the extracted release itself. Its server gets an empty PATH and an unrelated cwd.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, cp, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
const root = path.resolve(import.meta.dirname, '..');
const archive = path.resolve(process.argv[2] ?? JSON.parse(await readFile(path.join(root, 'artifacts/latest-release.json'), 'utf8')).archive);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await readFile(archive)), (await readFile(archive + '.sha256', 'utf8')).split(/\s+/)[0]);
const temp = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-release-'));
let child, output = '', successMessage = '';
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = path.join(temp, 'empty-path');
for (const key of ['VOIDPLAYER_CONFIG', 'VOIDPLAYER_DATA_DIR', 'VOIDPLAYER_PROXY_TOKEN', 'BUN_OPTIONS', 'BUN_INSPECT']) delete env[key];
const cwd = path.join(temp, 'unrelated cwd'), data = path.join(temp, 'persistent data'), media = path.join(temp, 'nested media');
const freePort = async () => { const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); return port; };
let executable;
const run = (args, overrides = {}) => execFileSync(executable, args, { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 7500);
  try { const [code, signal] = await done; if (process.platform === 'win32') assert.ok(code === 0 || signal === 'SIGTERM', 'Windows process termination'); else assert.equal(code, 0, `${signal}\n${output}`); } finally { clearTimeout(timer); child = null; }
}
async function start(port, extraEnv = {}, args = []) {
  output = '';
  child = spawn(executable, ['--data-dir', data, '--port', String(port), ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    if (await fetch(base + '/api/ready').then(r => r.ok).catch(() => false)) return base;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Startup timed out: ' + output);
}
try {
  await mkdir(cwd); await mkdir(env.PATH); await mkdir(path.join(media, '子目录'), { recursive: true });
  await writeFile(path.join(cwd, 'voidplayer.config.json'), '{"wrong-directory":true}');
  await writeFile(path.join(cwd, '.env'), 'VOIDPLAYER_CONFIG=must-not-autoload.json\n');
  const bytes = Buffer.alloc(4 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(path.join(media, '子目录', 'sample.mp4'), bytes);
  await utimes(path.join(media, '子目录', 'sample.mp4'), 1, 1);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', temp]);
  const folder = path.join(temp, path.basename(archive, '.tar.gz'));
  const manifest = JSON.parse(await readFile(path.join(folder, 'release.json'), 'utf8'));
  assert.equal(manifest.target, `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`, 'Test on the target OS/architecture');
  assert.equal(manifest.runtime.name, 'bun');
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(digest(await readFile(path.join(folder, file))), hash, file);
  assert.ok(!(await readdir(folder)).some(n => ['server', 'node_modules', 'package.json', 'logs'].includes(n)));
  executable = path.join(folder, manifest.executable);
  assert.match(run(['--version']), /VoidPlayer .*preview/); assert.match(run(['--help']), /--init/);
  run(['--init', '--data-dir', data, '--folder', media]);
  const configPath = path.join(data, 'voidplayer.config.json'), original = await readFile(configPath, 'utf8');
  assert.equal(JSON.parse(original).staticDir, undefined, 'configuration must not pin old program assets');
  assert.equal(JSON.parse(original).logsDir, 'logs', 'backup can relocate the data directory');
  assert.equal(JSON.parse(original).mediaRoots[0].path, media);
  assert.match(JSON.parse(original).mediaRoots[0].id, /^[0-9a-f]{24}$/, 'init writes a stable root identity');
  assert.throws(() => run(['--init', '--data-dir', data, '--folder', media]), /EEXIST/);
  assert.equal(await readFile(configPath, 'utf8'), original);
  run(['--check', '--data-dir', data]);
  assert.throws(() => run(['--check', '--data-dir', data, '--folder', path.join(temp, 'missing')]), /媒体目录不存在/);
  assert.throws(() => run(['--check', '--data-dir', data, '--host', '0.0.0.0']), /认证网关/);
  const port = await freePort(); let base = await start(port);
  run(['--healthcheck', '--data-dir', data, '--port', String(port)]);
  const homepage = await fetch(base); assert.equal(homepage.status, 200); assert.match(await homepage.text(), /VoidPlayer/);
  assert.equal(homepage.headers.get('cross-origin-opener-policy'), 'same-origin'); assert.equal(homepage.headers.get('cross-origin-embedder-policy'), 'require-corp');
  const wasm = await fetch(base + '/vendor/voidplayer-core/voidplayer-core.wasm', { method: 'HEAD' }); assert.equal(wasm.status, 200); assert.match(wasm.headers.get('content-type'), /application\/wasm/);
  const listing = await (await fetch(base + '/api/library')).json(); assert.equal(listing.entries.length, 1);
  assert.match(listing.entries[0].version, /^[0-9a-f]{24}$/);
  assert.equal((await readFile(path.join(data, 'library.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.throws(() => run(['--data-dir', data, '--port', String(port)]), /另一个实例/, 'second process cannot write the same index');
  const url = base + '/api/media/' + listing.entries[0].id + '?v=' + listing.entries[0].version;
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const start = i * 10007, end = start + 1023;
    const r = await fetch(url, { headers: { range: `bytes=${start}-${end}` } }); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(start, end + 1));
  }));
  const suffix = await fetch(url, { headers: { range: 'bytes=-32' } }); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-32));
  assert.equal((await fetch(url, { headers: { range: `bytes=${bytes.length}-` } })).status, 416);
  const controller = new AbortController(); const streaming = await fetch(url, { signal: controller.signal }); await streaming.body.getReader().read(); controller.abort();
  assert.equal((await fetch(base + '/api/ready')).status, 200);
  const uploaded = await fetch(base + '/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'voidplayer-web-log', sessionId: 'release-test' }) }); assert.equal(uploaded.status, 201);
  assert.equal((await readdir(path.join(data, 'logs'))).length, 1);
  await stop();
  const upgraded = path.join(temp, 'upgraded program'); await rename(folder, upgraded); executable = path.join(upgraded, manifest.executable);
  base = await start(port); assert.equal((await fetch(base)).status, 200); assert.equal(await readFile(configPath, 'utf8'), original); assert.equal((await readdir(path.join(data, 'logs'))).length, 1);
  await stop();
  // A stopped full-data backup must restore into a fresh directory, not only
  // survive a program-directory rename. Keep the original for comparison.
  const backup = path.join(temp, 'data backup');
  await cp(data, backup, { recursive: true });
  await rename(data, path.join(temp, 'original data'));
  await cp(backup, data, { recursive: true });
  assert.throws(() => run(['--check', '--data-dir', data, '--static', path.join(temp, 'broken upgrade')]), /缺少构建后的网页/);
  run(['--check', '--data-dir', data]);
  const offlineMedia = media + '-offline'; await rename(media, offlineMedia);
  base = await start(port);
  assert.equal(await readFile(configPath, 'utf8'), original);
  assert.equal((await readdir(path.join(data, 'logs'))).length, 1);
  const restored = await (await fetch(base + '/api/library')).json();
  assert.equal(restored.entries.length, 1, 'restored index stays queryable while storage is offline');
  assert.equal(restored.entries[0].id, listing.entries[0].id);
  assert.equal(restored.entries[0].version, listing.entries[0].version);
  assert.equal((await fetch(url)).status, 404, 'offline index cannot grant stale file access');
  await stop();
  await rename(offlineMedia, media);
  const token = randomBytes(32).toString('hex'); base = await start(port, { VOIDPLAYER_PROXY_TOKEN: token }, ['--host', '0.0.0.0']);
  assert.equal((await fetch(base + '/api/library')).status, 401);
  assert.equal((await fetch(base + '/api/library', { headers: { 'x-voidplayer-user': 'forged' } })).status, 401);
  assert.equal((await fetch(base + '/api/library', { headers: { 'x-voidplayer-user': 'release.test', 'x-voidplayer-proxy-token': token } })).status, 200);
  await stop();
  if (process.env.RELEASE_BENCH === '1') {
    base = await start(port, {}, ['--folder', path.join(root, 'fixtures/video')]);
    // The test harness uses Node/Playwright; the service still runs with empty PATH.
    const bench = spawn(process.execPath, [path.join(root, 'scripts/bench-playback.mjs'), 'webkit', '--headless'], { cwd: root, env: { ...process.env, BASE_URL: base, BENCH_REPEATS: '1', BENCH_DURATION_MS: '4000' }, stdio: 'inherit' });
    const [code] = await once(bench, 'exit'); assert.equal(code, 0); await stop();
  }
  successMessage = `PASS standalone ${manifest.target}: archive hashes, empty PATH, unrelated cwd, init/check, HTTP/HEAD/Range/concurrency/abort, explicit log upload, gateway identity, ${process.platform === 'win32' ? 'process termination (Ctrl+C verified by the separate console check)' : 'graceful stop'}, SQLite process lock and upgrade/backup/restore preserving offline index`;
} finally { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done.catch(() => {}); } await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
console.log(successMessage);
