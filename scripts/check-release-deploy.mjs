import { verifySavedWorkspaces, verifyWorkspaceRestore } from './workspace-acceptance.mjs';
import { verifyMeasurements } from './measurement-acceptance.mjs';
// Exercise the shipped Linux Docker/Compose/Caddy templates, not a test-only server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
assert.equal(process.platform, 'linux', 'Run on a Linux Docker host');
const release = JSON.parse(await readFile('artifacts/latest-release.json', 'utf8'));
assert.equal(release.target, `bun-linux-${process.arch}`);
const temp = await mkdtemp(path.join(os.tmpdir(), 'vp-deploy-'));
const project = `vp-qa-${randomBytes(6).toString('hex')}`;
const program = path.join(temp, 'program'), media = path.join(temp, 'media');
await cp(release.directory, program, { recursive: true });
await mkdir(media, { mode: 0o755 });
const bytes = Buffer.alloc(1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
await writeFile(path.join(media, 'sample.mp4'), bytes, { mode: 0o644 });
await utimes(path.join(media, 'sample.mp4'), 1, 1);
const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const token = randomBytes(32).toString('hex'), password = randomBytes(18).toString('hex');
const env = { ...process.env, VOIDPLAYER_SITE: 'https://localhost', VOIDPLAYER_MEDIA_DIR: media, VOIDPLAYER_PROXY_TOKEN: token, VOIDPLAYER_ADMIN_USERS: 'qa.tester' };
const files = ['-f', path.join(program, 'deploy/compose.yaml'), '-f', path.join(temp, 'qa.yaml')];
const docker = (args, options = {}) => execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000, ...options });
const compose = args => docker(['compose', '-p', project, ...files, ...args]);
// Change only test host ports; keep shipped auth, read-only mounts, images and health checks.
await writeFile(path.join(temp, 'qa.yaml'), `services:\n  gateway:\n    ports: !override\n      - "127.0.0.1:${port}:443"\n`);
let started = false;
try {
  const hash = docker(['run', '--rm', '-i', 'caddy:2.11.4', 'caddy', 'hash-password'], { input: password + '\n' }).trim();
  await writeFile(path.join(program, 'deploy/users.caddy'), `qa.tester ${hash}\n`);
  compose(['config', '--quiet']);
  started = true;
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '120']);
  const caFile = path.join(temp, 'root.crt');
  compose(['cp', 'gateway:/data/caddy/pki/authorities/local/root.crt', caFile]);
  const ca = await readFile(caFile);
  const get = (url, headers = {}, trusted = true, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request(`https://localhost:${port}${url}`, { method, family: 4, agent: false, ...(trusted ? { ca } : {}), headers, timeout: 5000 }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS request timed out'))); req.end(body);
  });
  await assert.rejects(get('/', {}, false), /certificate|issuer|self.signed/i, 'TLS requires trusting this deployment CA');
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/', { authorization: 'Basic ' + Buffer.from('qa.tester:wrong').toString('base64') })).status, 401);
  const auth = { authorization: 'Basic ' + Buffer.from(`qa.tester:${password}`).toString('base64'), 'x-voidplayer-user': 'forged', 'x-voidplayer-proxy-token': 'forged' };
  const home = await get('/', auth); assert.equal(home.status, 200); assert.match(home.body.toString(), /VoidPlayer/);
  assert.equal(home.headers['cross-origin-opener-policy'], 'same-origin'); assert.equal(home.headers['cross-origin-embedder-policy'], 'require-corp');
  const wasm = await get('/vendor/voidplayer-core/voidplayer-core.wasm', auth, true, 'HEAD');
  assert.equal(wasm.status, 200); assert.match(wasm.headers['content-type'], /application\/wasm/); assert.equal(wasm.body.length, 0);
  assert.equal(JSON.parse((await get('/api/health', auth)).body).actor.id, 'qa.tester');
  const listing = JSON.parse((await get('/api/library', auth)).body); assert.equal(listing.entries.length, 1);
  await verifyMeasurements((url, options) => get(url, { ...auth, ...options.headers, origin: `https://localhost:${port}` }, true, options.method, options.body), listing.entries[0]);
  const workspaceTransport = (url, options) => get(url, { ...auth, ...options.headers, origin: `https://localhost:${port}` }, true, options.method, options.body);
  const savedWorkspace = await verifySavedWorkspaces(workspaceTransport, listing.entries[0], `https://localhost:${port}/`, 'qa.tester');
  const url = `/api/media/${listing.entries[0].id}`;
  await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const start = i * 8192, end = start + 1023;
    const part = await get(url, { ...auth, range: `bytes=${start}-${end}` });
    assert.equal(part.status, 206); assert.deepEqual(part.body, bytes.subarray(start, end + 1));
  }));
  assert.equal(compose(['exec', '-T', 'app', 'id', '-u']).trim(), '1000');
  assert.equal(compose(['exec', '-T', 'app', 'sh', '-c', 'command -v node || command -v bun || true']).trim(), '');
  assert.match(compose(['exec', '-T', '-w', '/tmp', 'app', '/app/voidplayer', '--version']), /VoidPlayer/);
  const appId = compose(['ps', '-q', 'app']).trim();
  const app = JSON.parse(docker(['inspect', appId]))[0];
  assert.equal(app.HostConfig.ReadonlyRootfs, true);
  assert.ok(!Object.values(app.NetworkSettings.Ports).some(Boolean), 'Only the authenticated gateway may publish ports');
  assert.equal(app.Mounts.find(m => m.Destination === '/media').RW, false);
  assert.equal(app.Mounts.find(m => m.Destination === '/data').RW, true);
  compose(['exec', '-T', 'app', 'test', '-s', '/data/library.sqlite']);
  assert.equal((await get('/admin', auth)).status, 200);
  assert.equal(JSON.parse((await get('/api/admin/status', auth)).body).identity.id, 'qa.tester');
  const rootConfig = JSON.parse((await get('/api/admin/roots', auth)).body);
  assert.equal(rootConfig.writable, true); assert.equal(rootConfig.configFile, '/data/voidplayer.config.json');
  const saved = await get('/api/admin/roots', { ...auth, origin: `https://localhost:${port}`, 'x-voidplayer-action': 'admin', 'content-type': 'application/json' }, true, 'PUT', JSON.stringify({ revision: rootConfig.revision, roots: rootConfig.roots.map(r => ({ ...r, name: 'QA archive' })) }));
  assert.equal(saved.status, 200, saved.body.toString());
  const beforeScan = JSON.parse((await get('/api/library/scan', auth)).body).job.id;
  compose(['restart']);
  compose(['up', '-d', '--wait', '--wait-timeout', '120']);
  // Compose waits for app health; wait separately for the restarted TLS listener.
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await get('/')).status === 401; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'Restarted gateway must become ready');
  assert.equal((await get(url, { ...auth, range: 'bytes=0-7' })).status, 206);
  await verifyWorkspaceRestore(workspaceTransport, savedWorkspace);
  const afterScan = JSON.parse((await get('/api/library/scan', auth)).body).job.id;
  assert.ok(afterScan > beforeScan, 'restart keeps scan history in the persistent data volume');
  assert.equal(JSON.parse((await get('/api/admin/roots', auth)).body).roots[0].name, 'QA archive', 'entrypoint must not overwrite saved configuration after restart');
  compose(['cp', 'gateway:/data/caddy/pki/authorities/local/root.crt', caFile]);
  assert.deepEqual(await readFile(caFile), ca, 'Restart retains the trusted CA');
  const logs = compose(['logs', '--no-color', 'app']);
  assert.match(logs, /"actorId":"qa.tester"/); assert.ok(!logs.includes(token));
  console.log('PASS shipped Docker deployment: no Node/Bun, non-root/read-only runtime, verified TLS, login/spoof rejection, page/WASM headers, four concurrent media ranges, four bounded measurements through TLS, admin identity and writable configuration on /data, persistent configuration/index/versioned workspaces and CA after restart');
} catch (error) {
  if (started) { try { console.error(compose(['logs', '--no-color', '--tail', '80'])); } catch {} }
  throw error;
} finally {
  // This randomly named project and its test-only volumes belong to this harness.
  if (started) compose(['down', '--volumes', '--remove-orphans']);
  await rm(temp, { recursive: true, force: true });
}
