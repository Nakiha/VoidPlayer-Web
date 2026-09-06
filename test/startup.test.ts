import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve())); return port;
}
async function until(check: () => Promise<boolean>, failure: () => string) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(failure());
}

test('one dev process starts both listeners, proxies API and closes both on SIGTERM', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vp-start-'));
  const apiPort = await freePort(), port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['scripts/dev.ts', '--folder', folder, '--data-dir', path.join(folder, 'data'), '--port', String(port), '--api-port', String(apiPort), '--no-logs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    await until(async () => fetch(`http://127.0.0.1:${port}/api/ready`).then(r => r.ok).catch(() => false), () => output);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200);
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/api/health`));
  } finally { child.kill('SIGKILL'); await exited; await fsCleanup(folder); }
});
async function fsCleanup(folder: string) { await rm(folder, { recursive: true, force: true }); }

test('production start serves the built page and API from one listener; missing build fails', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vp-prod-'));
  const port = await freePort(); let output = '';
  await mkdir(path.join(folder, 'web')); await writeFile(path.join(folder, 'web/index.html'), '<title>Release</title>');
  const child = spawn(process.execPath, ['server/main.ts', '--folder', folder, '--data-dir', path.join(folder, 'data'), '--static', path.join(folder, 'web'), '--port', String(port), '--no-logs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    await until(async () => fetch(`http://127.0.0.1:${port}/api/ready`).then(r => r.ok).catch(() => false), () => output);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Release/);
    child.kill('SIGTERM'); assert.equal(await exited, 0);
    const bad = spawn(process.execPath, ['server/main.ts', '--folder', folder, '--data-dir', path.join(folder, 'data'), '--static', path.join(folder, 'missing')], { stdio: 'ignore' });
    assert.equal(await new Promise(resolve => bad.once('exit', resolve)), 1);
  } finally { child.kill('SIGKILL'); await exited; await fsCleanup(folder); }
});
