import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { releaseVersion, readReleaseIdentity, readBuildIdentity, verifyFrontendIdentity, readReleaseNotes } from '../../scripts/release-version.mjs';
import { verifyReleaseSet, sha256, releasePlatforms } from '../../scripts/check-release-set.mjs';
import { stageRelease } from '../../scripts/stage-release.mjs';
import { blockingFlvBenchmarkFailures } from '../../scripts/testing/flv-benchmark-policy.mjs';

test('virtual FLV timing reports retain negative verdicts and never waive functional failures', () => {
  const benchmark = { passed: false, tracks: [{ decoder: 'ffmpeg-wasm' }], environment: { hardwareUseVerified: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/153.0' }, failures: ['below-realtime', 'A:presentation-stall'] };
  const context = { virtualRunner: true, engine: 'chromium', renderer: 'webgl-yuv' };
  assert.deepEqual(blockingFlvBenchmarkFailures(benchmark, context), []);
  assert.equal(benchmark.passed, false);
  assert.deepEqual(benchmark.failures, ['below-realtime', 'A:presentation-stall']);
  for (const patch of [{ virtualRunner: false }, { engine: 'webkit' }, { renderer: 'cpu-yuv' }, { renderer: 'unknown' }]) {
    assert.deepEqual(blockingFlvBenchmarkFailures(benchmark, { ...context, ...patch }), benchmark.failures);
  }
  for (const failure of ['insufficient-sample', 'no-frames', 'A:no-frames', 'frame-lag', 'track-skew', 'pause-latency', 'stale-frame-after-pause', 'playback-error', 'interrupted', 'premature-end', 'media-changed', 'page-not-visible', 'unknown']) {
    assert.deepEqual(blockingFlvBenchmarkFailures({ ...benchmark, failures: [...benchmark.failures, failure] }, context), [failure]);
  }
  assert.deepEqual(blockingFlvBenchmarkFailures({ ...benchmark, tracks: [{ decoder: 'webcodecs' }] }, { ...context, renderer: 'browser-managed' }), []);
  for (const environment of [{}, { ...benchmark.environment, hardwareUseVerified: true }, { ...benchmark.environment, userAgent: 'Chrome/153.0' }, { ...benchmark.environment, userAgent: 'HeadlessChrome/153.0 Macintosh' }]) {
    assert.deepEqual(blockingFlvBenchmarkFailures({ ...benchmark, environment }, context), benchmark.failures);
  }
  assert.deepEqual(blockingFlvBenchmarkFailures({ ...benchmark, tracks: [{ decoder: 'unknown' }] }, context), benchmark.failures);
  assert.deepEqual(blockingFlvBenchmarkFailures({ ...benchmark, tracks: [] }, context), benchmark.failures);
});

// These structural contracts run in the identity job before npm ci. Keep them
// dependency-free and fail closed if the workflow's job/needs syntax changes.
function workflowJobs(source) {
  const jobs = source.slice(source.indexOf('\njobs:\n') + 7);
  return Object.fromEntries([...jobs.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map(([, id, body]) => {
      const value = /^    needs: (.+)$/m.exec(body)?.[1];
      const needs = value ? (value.startsWith('[') ? value.slice(1, -1).split(',').map(item => item.trim()) : [value]) : [];
      assert.ok(needs.every(item => /^[\w-]+$/.test(item)), `${id}: unsupported needs syntax`);
      return [id, { body, needs }];
    }));
}

test('release workflow gates verified artifacts and draft staging on every verification job', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const jobs = workflowJobs(workflow);
  const required = ['native-release', 'playback', 'source-logic', 'analysis-logic', 'analysis-browser', 'hevc-browser', 'uncovered-regressions'];
  assert.deepEqual([...jobs['release-set'].needs].sort(), required.sort());
  const dependencies = id => new Set(jobs[id].needs.flatMap(need => {
    assert.ok(jobs[need], `unknown dependency ${need}`);
    return [need, ...dependencies(need)];
  }));
  // This one PR-only measurement is informational. Every other verification
  // job remains required, including any newly added job not explicitly audited.
  const informational = jobs['paired-https'];
  assert.ok(informational, 'paired performance job exists');
  assert.deepEqual(informational.needs, ['decoder', 'analysis-core']);
  assert.match(informational.body, /^    if: github.event_name == 'pull_request'$/m);
  assert.match(informational.body, /id: paired-performance\n        continue-on-error: true/);
  assert.match(informational.body, /run: node scripts\/run-tests\.mjs ci-perf-pair --prepared/);
  assert.match(informational.body, /if: always\(\)[\s\S]*name: paired-https-performance-reports/);
  assert.doesNotMatch(informational.body, /stage-release|check-release-set|verified-release-set/);
  assert.deepEqual([...dependencies('release-set')].sort(), Object.keys(jobs).filter(id => !['release-set', 'release-draft', 'paired-https'].includes(id)).sort(),
    'every new required verification job must be in the release dependency graph');
  for (const id of ['release-set', ...dependencies('release-set')]) {
    assert.doesNotMatch(jobs[id].body, /^    (?:if|continue-on-error):/m, `${id} must retain success-only job gating`);
  }
  assert.deepEqual(jobs['release-draft'].needs, ['release-set']);
  assert.match(jobs['release-draft'].body, /^    if: github\.ref_type == 'tag'$/m);
  assert.doesNotMatch(jobs['release-draft'].body, /continue-on-error:/);
  assert.match(jobs['release-set'].body, /name: verified-release-set/);
  assert.match(jobs['release-draft'].body, /name: verified-release-set/);
  assert.doesNotMatch(jobs['release-set'].body, /if:.*(?:always\(|!cancelled\(|failure\()/);
  // Model GitHub's default success() dependency predicate for the observed
  // missing edge: failure, cancellation, pending and skipped all block output.
  for (const outcome of ['failure', 'cancelled', 'pending', 'skipped', 'success']) {
    const outcomes = Object.fromEntries(required.map(id => [id, id === 'uncovered-regressions' ? outcome : 'success']));
    const produceVerifiedSet = jobs['release-set'].needs.every(id => outcomes[id] === 'success');
    const stageDraft = jobs['release-draft'].needs.every(id => id === 'release-set' && produceVerifiedSet);
    assert.equal(produceVerifiedSet, outcome === 'success');
    assert.equal(stageDraft, outcome === 'success');
  }
});

test('browser workflow collects independent outcomes and uploads failure evidence', async () => {
  const jobs = workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8'));
  assert.match(jobs['uncovered-regressions'].body, /run: node scripts\/run-tests\.mjs uncovered --prepared/);
  assert.doesNotMatch(jobs['uncovered-regressions'].body, /continue-on-error:|set -euo pipefail/);
  assert.match(jobs['uncovered-regressions'].body, /if: always\(\)[\s\S]*name: uncovered-browser-reports[\s\S]*\.run\/test-suites\/uncovered\//);
  assert.match(jobs.playback.body, /if: \$\{\{ !cancelled\(\) && steps\.browser-inputs\.outcome == 'success' \}\}\n        run: node scripts\/run-tests\.mjs flv-startup --prepared/);
  assert.match(jobs.playback.body, /\.run\/test-suites\//);
});

const revision = 'a'.repeat(40), identity = { version: '0.1.0', revision, dirty: false, tag: 'v0.1.0' };
test('release versions match package and tag, reject dirty tags and invalid versions', () => {
  const input = { packageVersion: '0.1.0', revision, dirty: false };
  assert.equal(releaseVersion(input), '0.1.0-preview.aaaaaaaa');
  assert.equal(releaseVersion({ ...input, dirty: true }), '0.1.0-preview.aaaaaaaa.dirty');
  assert.equal(releaseVersion({ ...input, tag: 'v0.1.0' }), '0.1.0');
  assert.equal(releaseVersion({ ...input, tag: 'v0.1.0-rc.1' }), '0.1.0-rc.1');
  for (const tag of ['v0.2.0', '0.1.0', 'v0.1.0-rc.01', 'v0.1.0+build', 'v0.1.0\n', '../x']) assert.throws(() => releaseVersion({ ...input, tag }));
  assert.throws(() => releaseVersion({ ...input, tag: 'v0.1.0', dirty: true }));
});

test('tag identity requires the current commit, a clean checkout and committed release notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-tag-'));
  const git = (...args          ) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
    await mkdir(path.join(root, 'docs/releases'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"version":"0.1.0"}');
    await writeFile(path.join(root, 'docs/releases/0.1.0.md'), '# Release notes\n');
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'); git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v0.1.0', '-m', 'release');
    const result = await readReleaseIdentity(root, 'v0.1.0');
    assert.equal(result.revision, git('rev-parse', 'HEAD')); assert.equal(result.version, '0.1.0');
    assert.match(await readReleaseNotes(root, result), /Release notes/);
    assert.deepEqual(await readBuildIdentity(root, 'v0.1.0'), result, 'frontend uses exactly the native release identity');
    const preview = await readBuildIdentity(root, '');
    assert.equal(preview.version, `0.1.0-preview.${result.revision.slice(0, 8)}`);
    assert.equal(preview.revision, result.revision, 'diagnostics preserve the full revision');
    git('-c', 'tag.gpgsign=false', 'tag', 'v0.1.0-rc.1');
    assert.equal((await readBuildIdentity(root, 'v0.1.0-rc.1')).version, '0.1.0-rc.1');
    await writeFile(path.join(root, 'untracked'), 'x');
    await assert.rejects(readReleaseIdentity(root, 'v0.1.0'), /未提交/);
    await assert.rejects(readBuildIdentity(root, 'v0.1.0'), /未提交/);
    assert.equal((await readBuildIdentity(root, '')).version, `0.1.0-preview.${result.revision.slice(0, 8)}.dirty`);
    git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'next');
    await assert.rejects(readReleaseIdentity(root, 'v0.1.0'), /未指向/);
    await assert.rejects(readReleaseNotes(root, { ...result, version: '0.1.1' }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('frontend source archives are explicit development builds, never unverified tagged releases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-source-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"version":"2.3.4"}');
    assert.deepEqual(await readBuildIdentity(root, ''), { version: '2.3.4-development', revision: 'unknown', dirty: false, tag: '' });
    await assert.rejects(readBuildIdentity(root, 'v2.3.4'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging rejects stale frontend versions, revisions and release modes', () => {
  verifyFrontendIdentity(identity, identity);
  for (const key of ['version', 'revision', 'dirty', 'tag']) {
    assert.throws(() => verifyFrontendIdentity({ ...identity, [key]: 'mismatch' }, identity), new RegExp(`Frontend build ${key}`));
  }
  assert.throws(() => verifyFrontendIdentity(null, identity), /Frontend build version/);
});

const locked = { bunVersion: '1.4.2', coreSource: { revision: 'b'.repeat(40) }, analysisSource: {revision:'c'.repeat(40)} };
async function makeSet(root        , mutate = (_     , __        ) => {}) {
  const directory = path.join(root, 'set'); await mkdir(directory, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot , 'System32', 'tar.exe') : 'tar';
  for (const platform of releasePlatforms) {
    const name = `voidplayer-0.1.0-${platform}`, folder = path.join(root, name);
    await mkdir(folder, { recursive: true });
    const manifest = { schema: 'voidplayer-release', version: 2, appVersion: '0.1.0', revision, dirty: false, target: `bun-${platform}`, runtime: { name: 'bun', version: locked.bunVersion }, decoder: { source: locked.coreSource }, analysis: {source:locked.analysisSource}, files: Object.fromEntries(['voidplayer-core.js', 'voidplayer-core.wasm', 'voidplayer-core-mt.js', 'voidplayer-core-mt.wasm', 'provenance.json', 'LICENSES/COPYING.LGPLv2.1', 'LICENSES/dav1d-COPYING'].map(f => [`dist/vendor/voidplayer-core/${f}`, sha256(f)]).concat(['voidplayer-analysis.js','voidplayer-analysis.wasm','manifest.json','provenance.json','LICENSE'].map(f=>[`dist/vendor/voidplayer-analysis/${f}`,sha256(f)]))) };
    mutate(manifest, platform);
    await writeFile(path.join(folder, 'release.json'), JSON.stringify(manifest));
    const archive = path.join(directory, name + '.tar.gz');
    execFileSync(tar, ['-czf', archive, '-C', root, name]);
    await writeFile(archive + '.sha256', `${sha256(await readFile(archive))}  ${name}.tar.gz\n`);
  }
  return directory;
}

test('release aggregation rejects corrupt, incomplete, duplicate and mixed-revision/core platform sets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-set-'));
  try {
    const directory = await makeSet(root);
    assert.equal((await verifyReleaseSet(directory, identity, locked)).assets.length, 6);
    const archive = path.join(directory, 'voidplayer-0.1.0-linux-x64.tar.gz');
    await writeFile(archive, 'corrupt'); await assert.rejects(verifyReleaseSet(directory, identity, locked), /checksum/);
    await makeSet(root); await rm(archive); await assert.rejects(verifyReleaseSet(directory, identity, locked), /one archive/);
    for (const mutate of [
      (m     ) => { m.revision = 'c'.repeat(40); },
      (m     ) => { m.dirty = true; },
      (m     ) => { m.target = 'bun-linux-x64'; },
      (m     ) => { m.decoder.source = {}; },
      m => {m.analysis.source={};},
      m => {delete m.files['dist/vendor/voidplayer-analysis/voidplayer-analysis.wasm'];},
      (m     ) => { m.files['dist/vendor/voidplayer-core/voidplayer-core.wasm'] = 'd'.repeat(64); },
    ]) {
      await makeSet(root, (m, platform) => { if (platform === 'windows-x64') mutate(m); });
      await assert.rejects(verifyReleaseSet(directory, identity, locked));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fakeApi() {
  const bytes = Buffer.from('archive');
  const report = { assets: [{ name: 'example.tar.gz', bytes: bytes.length, sha256: sha256(bytes) }] };
  const state      = { release: null, assets: [], mutations: [], tagRevision: revision, failUpload: false };
  const api = async (endpoint        , options      = {}) => {
    if (endpoint.startsWith('git/ref/')) return { object: { type: 'tag', sha: 'b'.repeat(40) } };
    if (endpoint.startsWith('git/tags/')) return { object: { type: 'commit', sha: state.tagRevision } };
    if (endpoint.startsWith('releases?')) return state.release ? [state.release] : [];
    if (options.method) state.mutations.push([endpoint, options]);
    if (endpoint === 'releases' && options.method === 'POST') {
      state.release = { ...options.json, id: 1, upload_url: 'https://uploads.example.invalid/1{?name}', html_url: 'https://example.invalid/draft' };
      return state.release;
    }
    if (endpoint.startsWith('https://uploads.')) {
      if (state.failUpload) throw new Error('connection lost');
      const asset = { name: 'example.tar.gz', state: 'uploaded', size: options.bytes.length, digest: `sha256:${sha256(options.bytes)}` };
      state.assets.push(asset); return asset;
    }
    if (endpoint.includes('/assets?')) return state.assets;
    return state.release ? { ...state.release, assets: state.assets } : null;
  };
  return { state, args: { identity, notes: '# Notes', report, readAsset: async () => bytes, api } };
}

test('draft creation verifies uploaded bytes, stays private, and resumes without replacing assets', async () => {
  const { state, args } = fakeApi();
  state.failUpload = true;
  await assert.rejects(stageRelease(args), /connection lost/);
  assert.equal(state.release.draft, true);
  state.failUpload = false;
  assert.equal(await stageRelease(args), 'https://example.invalid/draft');
  const count = state.mutations.length;
  await stageRelease(args); assert.equal(state.mutations.length, count);
  assert.equal(state.release.prerelease, false);
  const preview = fakeApi(); preview.args.identity = { ...identity, tag: 'v0.1.0-rc.1', version: '0.1.0-rc.1' };
  await stageRelease(preview.args); assert.equal(preview.state.release.prerelease, true);
});

test('draft staging refuses moved tags, published versions, changed notes and replaced assets before writing', async () => {
  const moved = fakeApi(); moved.state.tagRevision = 'c'.repeat(40);
  await assert.rejects(stageRelease(moved.args), /remote tag/); assert.equal(moved.state.mutations.length, 0);
  for (const change of [
    (s     ) => { s.release.draft = false; },
    (s     ) => { s.release.target_commitish = 'c'.repeat(40); },
    (s     ) => { s.release.body += 'changed'; },
    (s     ) => { s.assets[0].digest = 'sha256:wrong'; },
    (s     ) => { s.assets[0].name = 'unrelated'; },
    (s     ) => { s.assets[0].state = 'starter'; },
  ]) {
    const { state, args } = fakeApi(); await stageRelease(args); change(state);
    const count = state.mutations.length;
    await assert.rejects(stageRelease(args)); assert.equal(state.mutations.length, count);
  }
});
