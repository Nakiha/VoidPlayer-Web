// Optional local TLS integration smoke. CADDY_BIN must name Caddy 2.11.4.
// Uses a private temporary CA; never installs a certificate in system trust.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { get } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const binary = process.env.CADDY_BIN;
if (!binary) throw new Error('Set CADDY_BIN to run the optional gateway smoke.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-gateway-'));
const freePort = async () => { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; };
const apiPort = await freePort(), tlsPort = await freePort();
const original = await readFile('deploy/Caddyfile', 'utf8');
const config = '{\n admin off\n auto_https disable_redirects\n skip_install_trust\n}\n' + original.replace('{$VOIDPLAYER_SITE} {', '{$VOIDPLAYER_SITE} {\n bind 127.0.0.1').replace('app:5180', `127.0.0.1:${apiPort}`);
await writeFile(path.join(directory, 'Caddyfile'), config);
const env = { ...process.env, VOIDPLAYER_SITE: `https://localhost:${tlsPort}`, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory };
let appOutput = '', gatewayOutput = '';
const app = spawn(process.execPath, ['server/main.ts','--folder','fixtures/video','--data-dir',path.join(directory,'app-data'),'--port',String(apiPort),'--no-logs'], { env, stdio: ['ignore','pipe','pipe'] });
app.stdout.on('data', d => { appOutput += d; }); app.stderr.on('data', d => { appOutput += d; });
let gateway;
const pause = () => new Promise(r => setTimeout(r, 100));
const wait = async fn => { const end = Date.now() + 15000; while(Date.now() < end) { try { if (await fn()) return; } catch {} await pause(); } throw new Error(appOutput + '\n' + gatewayOutput); };
try {
  await wait(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/ready`)).ok);
  execFileSync(binary, ['validate','--config',path.join(directory,'Caddyfile'),'--adapter','caddyfile'], { env, stdio: ['ignore','pipe','pipe'] });
  gateway = spawn(binary, ['run','--config',path.join(directory,'Caddyfile'),'--adapter','caddyfile'], { env, stdio: ['ignore','pipe','pipe'] });
  gateway.stdout.on('data', d => { gatewayOutput += d; }); gateway.stderr.on('data', d => { gatewayOutput += d; });
  const caPath = path.join(directory,'caddy/pki/authorities/local/root.crt');
  let ca; await wait(async () => { ca = await readFile(caPath); return true; });
  const request = (url, headers = {}) => new Promise((resolve,reject) => {
    const req = get(`https://localhost:${tlsPort}${url}`, { ca, family: 4, headers }, res => { const chunks=[]; res.on('data',d=>chunks.push(d)); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)})); }); req.on('error',reject);
  });
  await wait(async () => (await request('/')).status === 200);
  const health = await request('/api/health', { 'x-voidplayer-user': 'forged' });
  const actor = JSON.parse(health.body).actor;
  assert.ok(actor.id); assert.notEqual(actor.name, 'forged');
  const headers = { cookie: health.headers['set-cookie'][0].split(';')[0] };
  const listing = JSON.parse((await request('/api/library',headers)).body);
  const response = await request(`/api/media/${listing.entries[0].id}`, {...headers,range:'bytes=0-7'});
  assert.equal(response.status,206); assert.equal(response.body.length,8);
  assert.equal(response.headers['cross-origin-opener-policy'],'same-origin');
  assert.equal(response.headers['cross-origin-embedder-policy'],'require-corp');
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/library`,{headers:{'x-voidplayer-user':'forged'}})).status,200);
  await pause(); assert.ok(appOutput.includes(`"actorId":"${actor.id}"`));
  console.log('PASS: trusted TLS, automatic cookie identity, media Range, isolation headers, attributed access audit.');
} finally {
  for (const child of [gateway,app]) if (child && child.exitCode === null) { const exit = new Promise(r=>child.once('exit',r)); child.kill('SIGTERM'); const force = setTimeout(()=>child.kill('SIGKILL'),5000); await exit; clearTimeout(force); }
  await rm(directory,{recursive:true,force:true});
}
