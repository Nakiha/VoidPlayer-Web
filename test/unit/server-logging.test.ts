import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { RuntimeLog } from '../../server/logging/runtime.ts';
import { ReportLogs } from '../../server/logging/reports.ts';
import { attachRuntimeLog, serverLog } from '../../server/logging/logger.ts';
import { logPolicy } from '../../shared/service/logging.ts';

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-server-logs-'));
  try { await work(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const runtimePolicy = { segmentBytes: 65536, maxBytes: 196608, days: 14 };
const reportPolicy = { maxBytes: 1024, maxFiles: 2, days: 0 };
const document = () => Promise.resolve({ schema: 'voidplayer-web-log', sessionId: 'logging-test', events: [] });
const receipt = () => ({ id: randomUUID(), receivedAt: new Date().toISOString(), actorId: 'test' });
function segment(at: number, suffix = '.gz') {
  return `runtime-${new Date(at).toISOString().slice(0, 10)}-${at}-${randomUUID()}.jsonl${suffix}`;
}
async function records(directory: string) {
  const result = [];
  for (const name of await fs.readdir(directory)) if (name.endsWith('.jsonl.gz')) {
    const data = gunzipSync(await fs.readFile(path.join(directory, name))).toString();
    result.push(...data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  return result;
}

test('runtime logs rotate by size and UTC day, seal valid gzip and drain every accepted record on close', async t => fixture(async directory => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const logs = new RuntimeLog(directory, runtimePolicy);
  await logs.start();
  try {
    for (let seq = 0; seq < 32; seq++) {
      logs.write({ event: 'test', seq, payload: randomBytes(2000).toString('hex') }); await logs.flush();
    }
    assert.ok((await fs.readdir(directory)).some(name => name.endsWith('.gz')));
    const before = (await fs.readdir(directory)).filter(name => name.endsWith('.jsonl'));
    now += 86400000;
    logs.write({ event: 'next-day', seq: 32 });
    const close = logs.close(); assert.equal(logs.close(), close); await close;
    const entries = await records(directory);
    assert.deepEqual(entries.map(entry => entry.seq).sort((a, b) => a - b), Array.from({ length: 33 }, (_, i) => i));
    for (const name of await fs.readdir(directory)) if (name.endsWith('.gz'))
      assert.ok(gunzipSync(await fs.readFile(path.join(directory, name))).length <= runtimePolicy.segmentBytes);
    for (const name of before) await assert.rejects(fs.access(path.join(directory, name)));
    assert.equal(logs.status().pendingBytes, 0);
  } finally { await logs.close(); }
}));

test('runtime quota expires by segment time and evicts oldest regardless of access time, preserving unrelated files', async () => fixture(async directory => {
  const now = Date.now(), names = [];
  for (let i = 3; i >= 1; i--) {
    const name = segment(now - i * 1000); names.push(name);
    await fs.writeFile(path.join(directory, name), gzipSync(randomBytes(70000)));
  }
  const expired = segment(now - 61 * 86400000);
  await fs.writeFile(path.join(directory, expired), gzipSync('old'));
  await fs.utimes(path.join(directory, names[0]), new Date(), new Date());
  await fs.writeFile(path.join(directory, 'user-note.json'), 'keep');
  const logs = new RuntimeLog(directory, { ...runtimePolicy, days: logPolicy().runtime.days });
  await logs.start();
  try {
    await assert.rejects(fs.access(path.join(directory, names[0])));
    await assert.rejects(fs.access(path.join(directory, expired)));
    await fs.access(path.join(directory, names[1])); await fs.access(path.join(directory, names[2]));
    assert.equal(await fs.readFile(path.join(directory, 'user-note.json'), 'utf8'), 'keep');
    assert.ok(logs.status().bytes <= runtimePolicy.maxBytes);
    const withinRetention = segment(now - 30 * 86400000);
    await fs.writeFile(path.join(directory, withinRetention), gzipSync('one month old'));
    await logs.close();
    await fs.access(path.join(directory, withinRetention));
  } finally { await logs.close(); }
}));

test('failed gzip replacement retains raw bytes and restart recovers an interrupted compression', async t => fixture(async directory => {
  const logs = new RuntimeLog(directory, runtimePolicy); await logs.start();
  logs.write({ event: 'must-survive', seq: 1 }); await logs.flush();
  const rename = t.mock.method(fs, 'rename', async () => { throw Error('injected rename failure'); });
  await assert.rejects(logs.close(), /injected rename failure/);
  assert.ok((await fs.readdir(directory)).some(name => name.endsWith('.jsonl')));
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  rename.mock.restore();
  const raw = (await fs.readdir(directory)).find(name => name.endsWith('.jsonl'))!;
  await fs.writeFile(path.join(directory, raw + '.gz.tmp'), 'interrupted');
  const restarted = new RuntimeLog(directory, runtimePolicy); await restarted.start(); await restarted.close();
  assert.equal((await records(directory))[0].event, 'must-survive');
}));

test('runtime queue remains bounded under slow IO, reports drops, and keeps request failures with their correlation', async t => fixture(async directory => {
  const logs = new RuntimeLog(directory, runtimePolicy); await logs.start();
  const append = (logs as any).append.bind(logs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(logs as any, 'append', async (...args: unknown[]) => { await gate; return append(...args); });
  for (let i = 0; i < 600; i++) logs.write({ event: 'pressure', payload: 'x'.repeat(4000) });
  assert.ok(logs.status().pendingBytes! <= 1024 ** 2); assert.ok(logs.status().dropped! > 0);
  release(); await logs.flush();
  const detach = attachRuntimeLog(logs);
  try { serverLog.error('http-request-failed', Error('injected failure'), { requestId: 'request-123', actorId: 'actor-456' }); }
  finally { detach(); }
  await logs.close();
  const entries = await records(directory), error = entries.find(entry => entry.event === 'http-request-failed');
  assert.ok(entries.some(entry => entry.event === 'log-records-dropped'));
  assert.equal(error.requestId, 'request-123'); assert.equal(error.actorId, 'actor-456');
  assert.equal(error.error.message, 'injected failure'); assert.match(error.error.stack, /server-logging/);
}));

test('report admission serializes concurrent commits, rejects full storage and never evicts existing evidence', async () => fixture(async directory => {
  const reports = new ReportLogs(directory, reportPolicy);
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => reports.upload(document, receipt())));
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 2);
    const rejected = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 507);
    const page = await reports.list(); assert.equal(page.entries.length, 2);
    assert.ok(page.storage!.reports.bytes <= reportPolicy.maxBytes);
    const entry = page.entries[0]; await reports.delete(entry.name, entry.version);
    await reports.upload(document, receipt()); assert.equal((await reports.list()).entries.length, 2);
  } finally { await reports.close(); }
}));

test('disk exhaustion drops bounded records and recovery emits the lost-record count', async t => fixture(async directory => {
  const logs = new RuntimeLog(directory, runtimePolicy); await logs.start();
  const open = fs.open;
  const failure = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith('.jsonl')) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    return open(...args);
  });
  logs.write({ event: 'lost' }); await logs.flush();
  assert.equal(logs.status().dropped, 1); assert.match(logs.status().error!, /disk full/);
  failure.mock.restore();
  logs.write({ event: 'recovered' }); await logs.close();
  const entries = await records(directory);
  assert.equal(entries.find(entry => entry.event === 'log-records-dropped').count, 1);
  assert.ok(entries.some(entry => entry.event === 'recovered'));
}));

test('report expiration is opt-in and only removes recognized ordinary report files', async () => fixture(async directory => {
  const name = 'voidplayer-log-historical.json', keep = 'unrelated.json';
  await fs.writeFile(path.join(directory, name), '{}'); await fs.writeFile(path.join(directory, keep), 'keep');
  const old = new Date(Date.now() - 90 * 86400000); await fs.utimes(path.join(directory, name), old, old);
  const manual = new ReportLogs(directory, reportPolicy);
  assert.equal((await manual.list()).entries.length, 1); await manual.close();
  const expiring = new ReportLogs(directory, { ...reportPolicy, days: 30 });
  try {
    assert.equal((await expiring.list()).entries.length, 0);
    assert.equal(await fs.readFile(path.join(directory, keep), 'utf8'), 'keep');
  } finally { await expiring.close(); }
}));

test('a second writer cannot rotate an active runtime directory or admit reports against the same quota', async () => fixture(async directory => {
  const logs = new RuntimeLog(directory, runtimePolicy), other = new RuntimeLog(directory, runtimePolicy);
  await logs.start();
  try { await assert.rejects(other.start(), /另一个实例/); }
  finally { await logs.close(); }
  const reports = new ReportLogs(directory, reportPolicy), duplicate = new ReportLogs(directory, reportPolicy);
  try {
    await reports.list(); await assert.rejects(duplicate.list(), /另一个实例/);
  } finally { await reports.close(); await duplicate.close(); }
}));

test('log policy validates bounded storage and explicit report expiration', () => {
  assert.equal(logPolicy().runtime.days, 60);
  assert.equal(logPolicy().reports.days, 0);
  assert.equal(logPolicy({ runtime: { days: 7 } }).runtime.days, 7);
  for (const value of [{ runtime: { days: 0 } }, { runtime: { maxBytes: 1 } }, { reports: { days: -1 } },
    { reports: { maxFiles: 1.5 } }, { reports: { unknown: 1 } }, { runtime: null }, []]) assert.throws(() => logPolicy(value));
});

test('service launcher drains child stdout/stderr into compressed bounded logs without an append-only console file', async () => fixture(async directory => {
  for (const name of ['scripts/service-runner.mjs', 'server/logging/runtime.ts', 'server/logging/files.ts', 'server/library-store.ts', 'server/sqlite.ts', 'shared/service/logging.ts']) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.copyFile(new URL('../../' + name, import.meta.url), path.join(directory, name));
  }
  const message = '启动日志' + '测'.repeat(2100);
  await fs.writeFile(path.join(directory, 'server/main.ts'),
    `const bytes = Buffer.from(${JSON.stringify(message)}); process.stdout.write(bytes.subarray(0, 2)); process.stdout.write(bytes.subarray(2)); process.stderr.write('startup-error\\n');`);
  const output = execFileSync(process.execPath, [path.join(directory, 'scripts/service-runner.mjs'), '--production'],
    { cwd: directory, encoding: 'utf8', timeout: 10000 });
  assert.equal(output, '');
  const entries = await records(path.join(directory, '.run/service-logs/production'));
  assert.equal(entries.filter(entry => entry.level === 'info').map(entry => entry.message).join(''), message);
  assert.ok(entries.some(entry => entry.level === 'error' && entry.message === 'startup-error'));
  assert.equal(entries.some(entry => entry.message.includes('�')), false);
  await assert.rejects(fs.access(path.join(directory, '.run/production.log')));
}));
