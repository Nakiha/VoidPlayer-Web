// Counterbalance the existing trusted-HTTPS benchmark on one disposable runner.
// Its original thresholds, decoder choices and certificate lifecycle are unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') {
  throw new Error('Paired HTTPS is restricted to disposable Linux Actions runners.');
}
assert.ok(process.env.I18N_BASELINE_ROOT, 'provide the separately built pinned baseline');
const feature = path.resolve(import.meta.dirname, '../../..');
const baseline = path.resolve(process.env.I18N_BASELINE_ROOT);
assert.notEqual(baseline, feature);
const output = path.resolve(process.env.VOIDPLAYER_TEST_ARTIFACTS ?? path.join(feature, '.run/https-pair'));
await mkdir(output, { recursive: true });
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const media = {}, core = {};
for (const file of ['http-1080p-a.mp4', 'http-1080p-b.mp4']) {
  media[file] = await hash(path.join(feature, '.run/playback-media', file));
  assert.equal(await hash(path.join(baseline, '.run/playback-media', file)), media[file], 'paired media bytes');
}
for (const file of ['voidplayer-core.wasm', 'voidplayer-core-mt.wasm']) {
  core[file] = await hash(path.join(feature, 'public/vendor/voidplayer-core', file));
  assert.equal(await hash(path.join(baseline, 'public/vendor/voidplayer-core', file)), core[file], 'paired core bytes');
}
// Both checkouts must run the same canonical harness, rather than a new relaxed benchmark.
for (const file of ['scripts/check-http-playback.mjs', 'scripts/bench-playback.mjs', 'scripts/test-certificate-trust.mjs']) {
  assert.equal(await hash(path.join(baseline, file)), await hash(path.join(feature, file)), `unchanged ${file}`);
}
const revisions = Object.fromEntries([['baseline', baseline], ['feature', feature]].map(([name, root]) =>
  [name, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()]));
const summary = { order: ['baseline', 'feature', 'feature', 'baseline'], revisions, media, core,
  device: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, node: process.version },
  transport: 'trusted HTTPS via the existing disposable-runner NSS certificate lifecycle', sessions: [] };
let valid = true;
for (const [index, name] of summary.order.entries()) {
  const root = name === 'feature' ? feature : baseline;
  const reportFile = path.join(root, '.run/playback-reports/benchmark.json');
  const previous = await readFile(reportFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let log = '';
  try {
    await rm(reportFile, { force: true }); // Prevent a crashed child from supplying stale evidence.
    const child = spawn(process.execPath, ['scripts/check-http-playback.mjs', '--benchmark-only'], {
      cwd: root, env: { ...process.env, VOIDPLAYER_HTTPS_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes.toString(); });
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const rows = await readFile(reportFile, 'utf8').then(JSON.parse).catch(() => []);
    const configurationErrors = [];
    if (rows.length !== 4) configurationErrors.push(`expected four reports, got ${rows.length}`);
    for (const scenario of ['https-1080p-solo', 'https-1080p-dual']) for (const repeat of [1, 2]) {
      if (rows.filter(row => row.scenario === scenario && row.repeat === repeat).length !== 1) configurationErrors.push(`missing/duplicate ${scenario}/${repeat}`);
    }
    for (const row of rows) {
      const env = row.environment;
      if (!env?.secureContext || !env.crossOriginIsolated || !env.page?.startsWith('https://voidplayer.test:') || row.requestedWallMs !== 12000 || row.headless !== true) configurationErrors.push('HTTPS/isolation/duration/browser configuration');
      if (Object.entries(core).some(([file, digest]) => env?.build?.wasmDigests?.[file] !== digest)) configurationErrors.push('core digest mismatch');
      if (!env?.build?.sourceDigest) configurationErrors.push('missing runtime source digest');
      if (!row.tracks?.length || row.tracks.some(track => track.decoder !== 'webcodecs' || track.hardwareAcceleration !== 'no-preference')) configurationErrors.push('unexpected decoder configuration');
      if (!row.measurements || !Array.isArray(row.failures)) configurationErrors.push('missing benchmark measurements');
    }
    if (exitCode !== 0 && exitCode !== 1) configurationErrors.push(`unexpected child exit ${exitCode}`);
    const session = { index, name, exitCode, configurationErrors, reports: rows };
    summary.sessions.push(session);
    await writeFile(path.join(output, `${index + 1}-${name}.json`), JSON.stringify(session, null, 2));
    valid &&= configurationErrors.length === 0;
    console.log(`${index + 1}/${name}: exit=${exitCode}, samples=${rows.length}, failed=${rows.filter(row => !row.passed).length}, configurationErrors=${configurationErrors.length}`);
  } finally {
    await writeFile(path.join(output, `${index + 1}-${name}.log`), log);
    if (previous === null) await rm(reportFile, { force: true }); else await writeFile(reportFile, previous);
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  }
}
for (const name of ['baseline', 'feature']) {
  const digests = new Set(summary.sessions.filter(s => s.name === name).flatMap(s => s.reports.map(r => r.environment?.build?.sourceDigest)));
  valid &&= digests.size === 1 && !digests.has(undefined);
}
summary.configurationValid = valid;
summary.sampleCount = summary.sessions.reduce((n, s) => n + s.reports.length, 0);
summary.failedSamples = summary.sessions.reduce((n, s) => n + s.reports.filter(r => !r.passed).length, 0);
summary.passed = valid && summary.sampleCount === 16 && summary.failedSamples === 0 && summary.sessions.every(s => s.exitCode === 0);
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ configurationValid: valid, sampleCount: summary.sampleCount, failedSamples: summary.failedSamples, passed: summary.passed }));
process.exitCode = summary.passed ? 0 : 1;
