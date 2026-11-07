import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersion, readReleaseIdentity, readBuildIdentity, verifyFrontendIdentity, readReleaseNotes } from '../../scripts/release-version.mjs';
import { verifyReleaseSet, sha256, releasePlatforms } from '../../scripts/check-release-set.mjs';
import { stageRelease, verifyDraftReleaseSet } from '../../scripts/stage-release.mjs';
import { normalizeReleasePermissions, verifyReleaseArchivePermissions, verifyReleaseExecutablePermissions } from '../../scripts/tools/release/permissions.mjs';
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

test('daily verification is bounded and full release verification is explicit', async () => {
  const read = name => readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const daily = await read('checks'), release = await read('release-preview'), cores = await read('prepare-cores');
  const jobs = workflowJobs(daily), coreJobs = workflowJobs(cores);
  const reachable = id => new Set(jobs[id].needs.flatMap(need => [need, ...reachable(need)]));
  assert.deepEqual([...reachable('required')].sort(),Object.keys(jobs).filter(id=>id!=='required').sort(),
    'every daily job must be owned by the required verification dependency graph');
  assert.ok(coreJobs['analysis-core']&&coreJobs.decoder,'both independent core artifacts are prepared');
  assert.match(daily, /on:\n  pull_request:\n  push:\n    branches: \[main\]/);
  const fullTriggers = release.slice(release.indexOf('\non:\n'), release.indexOf('\npermissions:'));
  assert.match(fullTriggers, /tags: \['v\*'\]/);
  assert.match(fullTriggers, /workflow_dispatch:/);
  assert.doesNotMatch(fullTriggers, /pull_request|branches:|paths-ignore/);
  assert.doesNotMatch(daily, /ci-perf|benchmark-only|package-release|ci-native-|continue-on-error:/);
  assert.match(jobs.cores.body, /uses: \.\/\.github\/workflows\/prepare-cores\.yml/);
  assert.match(cores, /workflow_call:/);
  assert.match(coreJobs.decoder.body, /run-tests\.mjs --case release-core/);
  assert.match(jobs['source-logic'].body, /run-tests\.mjs source/);
  assert.match(jobs.unit.body, /run-tests\.mjs ci-node-media-\$\{\{ matrix.part \}\}\n/);
  assert.match(jobs.unit.body, /fail-fast: false/);
  assert.match(jobs.unit.body, /name: media-node-reports-\$\{\{ matrix.part \}\}/);
  assert.match(jobs.unit.body, /\.run\/test-suites\/ci-node-media-\$\{\{ matrix.part \}\}\//);
  assert.match(jobs.unit.body, /uses: \.\/\.github\/actions\/media-fixtures/);
  assert.match(jobs.browser.body, /engine: \[chromium, webkit\]/);
  assert.match(jobs.browser.body, /run-tests\.mjs ci-pr-browser --engine \$\{\{ matrix.engine \}\}/);
  assert.match(jobs.browser.body, /include-hidden-files: true/);
  assert.doesNotMatch(jobs.browser.body, /sync-samples|qa-samples|native-oracle/);
  assert.deepEqual(jobs.required.needs, ['source-logic', 'cores', 'unit', 'browser']);
  assert.match(jobs.required.body, /if: \$\{\{ always\(\) \}\}/);
  const guard = /^          node --input-type=module <<'JS'\n([\s\S]*?)^          JS$/m.exec(jobs.required.body)?.[1];
  assert.ok(guard);
  const run = results => spawnSync(process.execPath, ['--input-type=module', '-e', guard.replace(/^          /gm, '')], {
    encoding: 'utf8', env: { ...process.env, RESULTS: JSON.stringify(results) },
  }).status;
  assert.notEqual(run({}), 0);
  for (const dependency of jobs.required.needs) for (const result of ['success', 'failure', 'cancelled', 'skipped', 'pending']) {
    const outcomes = Object.fromEntries(jobs.required.needs.map(id => [id, { result: id === dependency ? result : 'success' }]));
    assert.equal(run(outcomes) === 0, result === 'success', `${dependency}: ${result}`);
  }
  const manifest = JSON.parse(await readFile(new URL('../../scripts/testing/manifest.json', import.meta.url), 'utf8'));
  const parts = /part: \[([^\]]+)\]/.exec(jobs.unit.body)[1].split(',').map(v=>v.trim());
  assert.deepEqual(parts,manifest.ciNodeMediaShards);
  const media = manifest.cases.filter(row=>row.suites.includes('ci-node-media'));
  const partitioned = parts.flatMap(part=>manifest.cases.filter(row=>row.suites.includes('ci-node-media-'+part)));
  assert.equal(new Set(partitioned.map(row=>row.id)).size,partitioned.length,'no repeated execution');
  assert.deepEqual(partitioned.map(row=>row.id).sort(),media.map(row=>row.id).sort(),'complete media coverage, not a daily subset');
  const profile = manifest.cases.filter(row => row.suites.includes('ci-pr-browser'));
  assert.deepEqual([...new Set(profile.flatMap(row=>row.engines))].sort(),['chromium','webkit']);
  assert.ok(profile.every(row => row.required && row.fixtures.every(value => ['core', 'analysis-core'].includes(value))));
  for (const engine of ['chromium', 'webkit']) for (const family of ['contracts', 'identity'])
    assert.ok(profile.some(row => row.id === `browser-${family}-${engine}`), `${family}/${engine}`);
  for (const row of manifest.cases.filter(row => row.suites.includes('ci-analysis-ui') || row.suites.includes('ci-identity-browser') || row.suites.includes('ci-identity-http')))
    assert.ok(profile.includes(row), `${row.id}: daily UI/identity coverage`);
  const fullJobs = workflowJobs(release);
  assert.doesNotMatch(fullJobs['analysis-matrix'].body, /--case node-/);
  for (const id of ['node-bitstream-analysis-ts', 'node-js-container-matrix', 'node-js-container-server-cache'])
    assert.ok(manifest.cases.find(row => row.id === id)?.suites.includes('ci-node-media'));
});

test('release workflow gates verified artifacts and draft staging on every verification job', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const jobs = workflowJobs(workflow);
  assert.match(jobs.identity.body, /- run: npm ci[\s\S]*- run: node --test test\/release-pipeline\.test\.mjs test\/test-manifest\.test\.mjs/);
  const cores = workflowJobs(await readFile(new URL('../../.github/workflows/prepare-cores.yml', import.meta.url), 'utf8'));
  assert.match(jobs.cores.body, /uses: \.\/\.github\/workflows\/prepare-cores\.yml/);
  assert.match(cores['analysis-core'].body, /name: Verify analysis reference ABI including restored caches\n        run: node scripts\/prepare-analysis-core.mjs public\/vendor\/voidplayer-analysis/);
  const required = ['native-release', 'native-runtime', 'unit', 'playback', 'cache-browser', 'source-logic', 'analysis-browser', 'analysis-matrix', 'hevc-browser', 'uncovered-regressions'];
  assert.deepEqual([...jobs['release-set'].needs].sort(), required.sort());
  assert.deepEqual(jobs.unit.needs, ['cores', 'qa-media']);
  assert.match(jobs.unit.body, /run: node scripts\/run-tests\.mjs ci-node-media\n        env:\n          VOIDPLAYER_FFMPEG_ORACLE:/);
  assert.equal((workflow.match(/run: node scripts\/run-tests\.mjs ci-node-media(?:\n|$)/g) ?? []).length, 1, 'media Node partition runs exactly once with no case filter');
  assert.doesNotMatch(jobs.playback.body, /run-tests\.mjs unit/);
  assert.match(jobs.unit.body, /if: always\(\)[\s\S]*name: media-node-reports[\s\S]*\.run\/test-suites\/ci-node-media\//);

  const dependencies = id => new Set(jobs[id].needs.flatMap(need => {
    assert.ok(jobs[need], `unknown dependency ${need}`);
    return [need, ...dependencies(need)];
  }));
  assert.equal(jobs['paired-https'], undefined, 'cloud benchmark comparison is removed');
  assert.doesNotMatch(workflow, /ci-perf|bench-playback|benchmark-only|VIRTUAL_PERF|performance-reports/);
  assert.match(jobs.playback.body, /run-tests\.mjs ci-https --prepared/);
  assert.deepEqual([...dependencies('release-set')].sort(), Object.keys(jobs).filter(id => !['release-set', 'release-draft'].includes(id)).sort(),
    'every new required verification job must be in the release dependency graph');
  for (const id of dependencies('release-set')) {
    assert.doesNotMatch(jobs[id].body, /^    (?:if|continue-on-error):/m, `${id} must retain success-only job gating`);
  }
  // Run the aggregate even for a skipped/cancelled/failed prerequisite, then
  // fail explicitly before downloading or producing any verified artifacts.
  assert.match(jobs['release-set'].body, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.doesNotMatch(jobs['release-set'].body, /continue-on-error:/);
  const gate = /      - name: Require every verification job to succeed\n([\s\S]*?)(?=      - )/.exec(jobs['release-set'].body)?.[1];
  assert.ok(gate, 'required result guard exists');
  assert.match(gate, /VERIFICATION_RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.doesNotMatch(gate, /if:|continue-on-error:/);
  assert.ok(jobs['release-set'].body.indexOf(gate) < jobs['release-set'].body.indexOf('uses: actions/download-artifact@v4'));
  const guard = /^          node --input-type=module <<'JS'\n([\s\S]*?)^          JS$/m.exec(gate)?.[1];
  assert.ok(guard, 'result guard uses the checked inline Node script');
  const verifyResults = results => spawnSync(process.execPath, ['--input-type=module', '-e', guard.replace(/^          /gm, '')], {
    encoding: 'utf8', env: { ...process.env, VERIFICATION_RESULTS: JSON.stringify(results) },
  });
  assert.notEqual(verifyResults({}).status, 0, 'missing results cannot pass');
  assert.deepEqual(jobs['release-draft'].needs, ['release-set']);
  assert.match(jobs['release-draft'].body, /^    if: github\.ref_type == 'tag'$/m);
  assert.doesNotMatch(jobs['release-draft'].body, /continue-on-error:/);
  assert.match(jobs['release-set'].body, /name: verified-release-set/);
  assert.match(jobs['release-draft'].body, /name: verified-release-set/);
  // Every required edge, including all cells of the analysis matrix job, must
  // block release output on failure, cancellation, pending or skipped states.
  for (const dependency of required) for (const outcome of ['failure', 'cancelled', 'pending', 'skipped', 'success']) {
    const outcomes = Object.fromEntries(required.map(id => [id, id === dependency ? outcome : 'success']));
    const checked = verifyResults(Object.fromEntries(jobs['release-set'].needs.map(id => [id, { result: outcomes[id] }])));
    const produceVerifiedSet = checked.status === 0;
    const stageDraft = jobs['release-draft'].needs.every(id => id === 'release-set' && produceVerifiedSet);
    assert.equal(produceVerifiedSet, outcome === 'success');
    assert.equal(stageDraft, outcome === 'success');
  }
});

test('all platform/runtime suites run independently of the compiled package jobs', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const jobs = workflowJobs(workflow), runtimeJob = jobs['native-runtime'], packaged = jobs['native-release'];
  const manifest = JSON.parse(await readFile(new URL('../../scripts/testing/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(runtimeJob.needs, ['cores']);
  assert.match(runtimeJob.body, /^    runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(runtimeJob.body, /^    timeout-minutes: 20$/m);
  assert.match(packaged.body, /^    timeout-minutes: 20$/m);
  assert.match(runtimeJob.body, /fail-fast: false\n      matrix:\n        runtime: \[node, bun\]\n        os: \[ubuntu-24\.04, windows-2022, macos-14\]/);
  assert.deepEqual([...packaged.body.matchAll(/platform: ([\w-]+)/g)].map(match => match[1]).sort(), ['darwin-arm64', 'linux-x64', 'windows-x64']);
  for (const body of [runtimeJob.body, packaged.body]) {
    assert.match(body, /uses: actions\/checkout@v4/);
    assert.match(body, /node-version: '24\.15\.0'/);
    assert.match(body, /bun-version-file: \.bun-version/);
    assert.match(body, /name: release-core\n          path: public\/vendor\/voidplayer-core/);
    assert.match(body, /name: release-analysis-core\n          path: public\/vendor\/voidplayer-analysis/);
    assert.match(body, /run: npm ci\n/);
    assert.match(body, /run: node scripts\/run-tests\.mjs --case release-core\n/);
    assert.doesNotMatch(body, /continue-on-error:/);
  }
  assert.match(runtimeJob.body, /if: always\(\)[\s\S]*name: native-runtime-reports-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.runtime \}\}[\s\S]*path: \.run\/test-suites\//);
  const expectedCounts = { node: 15, bun: 11 };
  for (const runtime of ['node', 'bun']) {
    const suite = `ci-native-${runtime}`, command = `run: node scripts/run-tests.mjs ${suite}\n`;
    assert.equal(runtimeJob.body.split(command).length - 1, 1);
    assert.equal(packaged.body.split(command).length - 1, 0);
    assert.ok(runtimeJob.body.includes(`if: matrix.runtime == '${runtime}'\n        ${command}`));
    for (const platform of ['linux', 'darwin', 'win32']) {
      const cases = manifest.cases.filter(row => row.suites.includes(suite) && row.platforms.includes(platform));
      assert.equal(cases.length, expectedCounts[runtime], `${runtime}/${platform} keeps every case`);
      assert.equal(new Set(cases.map(row => row.id)).size, cases.length);
      assert.ok(cases.every(row => row.required));
      assert.ok(cases.some(row => row.id === `${runtime}-http2`), `${runtime}/${platform} preserves HTTP/2 lifecycle regressions`);
      assert.ok(cases.some(row => row.id === `${runtime}-server-logging`), `${runtime}/${platform} preserves log rotation and storage regressions`);
      assert.ok(cases.some(row => row.id === `${runtime}-service-shutdown`));
    }
  }
  assert.match(runtimeJob.body, /ci-native-node\n        env:\n          NODE_OPTIONS: --test-reporter=tap/);
  for (const suite of ['--case release-analysis', 'ci-native-http --prepared', 'ci-native-https --prepared']) assert.ok(packaged.body.includes(`run: node scripts/run-tests.mjs ${suite}\n`));
  assert.doesNotMatch(packaged.body, /Prepare pinned Linux native quality components/);

});

test('cache suite runs once in its own required job with the same pinned preparation and evidence', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const jobs = workflowJobs(workflow), cache = jobs['cache-browser'];
  const manifest = JSON.parse(await readFile(new URL('../../scripts/testing/manifest.json', import.meta.url), 'utf8'));
  const cases = manifest.cases.filter(row => row.suites.includes('ci-cache'));
  const expected = ['browser-existing-page-bridge-chromium', 'browser-mcp-page-bridge-chromium', 'browser-sharing-webkit',
    'browser-annotation-persistence-chromium', 'browser-annotation-persistence-webkit', 'browser-cache-chromium', 'browser-cache-webkit'];
  assert.deepEqual(cases.map(row => row.id).sort(), expected.sort());
  const prCases = manifest.cases.filter(row => row.suites.includes('ci-cache-pr'));
  assert.deepEqual(prCases.map(row => row.id).sort(), expected.sort());
  assert.ok(cases.every(row => row.required && row.kind === 'regression'));
  assert.deepEqual(cache.needs, ['cores', 'qa-media']);
  assert.match(cache.body, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(cache.body, /^    timeout-minutes: 45$/m);
  assert.match(jobs.playback.body, /^    timeout-minutes: 45$/m);
  assert.doesNotMatch(cache.body, /strategy:|--engine|--stop-on-failure/);
  assert.doesNotMatch(cache.body, /continue-on-error:|ci-cache-pr --prepared|quality-browser-diagnostics/);
  assert.equal((workflow.match(/run: node scripts\/run-tests\.mjs ci-cache --prepared\n/g) ?? []).length, 1);
  assert.doesNotMatch(jobs.playback.body, /ci-cache|annotation-cache-screenshots/);
  assert.deepEqual([...cache.body.matchAll(/^        run: node scripts\/run-tests\.mjs ([^\n]+)$/gm)].map(row => row[1]), ['--prepare', 'ci-cache --prepared']);
  assert.match(cache.body, /if: \$\{\{ !cancelled\(\) && steps.browser-inputs.outcome == 'success' \}\}\n        run: node scripts\/run-tests\.mjs ci-cache --prepared/);

  const preparation = (body, end) => body.slice(body.indexOf('    steps:\n'), body.indexOf(`      - name: ${end}`));
  assert.equal(preparation(cache.body, 'Generate approximately 100 MB 1080p playback inputs'), preparation(jobs.playback.body, 'Verify identity and Agent annotation flows'),
    'same checkout, pinned core/QA/FATE/oracle, native tools, Playwright and verified build preparation');
  const fixtures = body => /      - name: Generate approximately 100 MB 1080p playback inputs\n[\s\S]*?(?=      - )/.exec(body)?.[0];
  assert.ok(fixtures(cache.body));
  assert.equal(fixtures(cache.body), fixtures(jobs.playback.body), 'preserve every preceding generated input');
  assert.match(cache.body, /if: always\(\)[\s\S]*name: annotation-cache-screenshots\n          include-hidden-files: true/);
  for (const artifact of ['/tmp/voidplayer-annotation-*.png', '/tmp/voidplayer-caches-*.png', '.run/workspace-sharing-browser-*/', '.run/test-suites/ci-cache/', '.run/test-suites/preparation/', '.run/test-suites/build-receipt.json', '.run/playback-reports/']) {
    assert.ok(cache.body.includes(`            ${artifact}\n`), `cache evidence retained: ${artifact}`);
  }
  assert.equal((workflow.match(/name: annotation-cache-screenshots\n/g) ?? []).length, 1);
  assert.ok(jobs['release-set'].needs.includes('cache-browser'));
});

test('browser workflow collects independent outcomes and uploads failure evidence', async () => {
  const jobs = workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8'));
  assert.match(jobs['uncovered-regressions'].body, /run: node scripts\/run-tests\.mjs uncovered --prepared/);
  assert.doesNotMatch(jobs['uncovered-regressions'].body, /continue-on-error:|set -euo pipefail/);
  assert.match(jobs['uncovered-regressions'].body, /if: always\(\)[\s\S]*name: uncovered-browser-reports[\s\S]*\.run\/test-suites\/uncovered\//);
  assert.match(jobs.playback.body, /if: \$\{\{ !cancelled\(\) && steps\.browser-inputs\.outcome == 'success' \}\}\n        run: node scripts\/run-tests\.mjs flv-startup --prepared/);
  assert.match(jobs.playback.body, /\.run\/test-suites\//);
  assert.match(jobs.playback.body, /if: always\(\)[\s\S]*name: https-playback-reports[\s\S]*\.run\/native-yuv-lifecycle\//);
});

test('analysis matrix runs as independent required jobs with distinct evidence', async () => {
  const jobs = workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8'));
  const matrix = jobs['analysis-matrix'];
  assert.deepEqual(matrix.needs, ['cores', 'qa-media']);
  assert.match(matrix.body, /timeout-minutes: 30/);
  assert.match(matrix.body, /fail-fast: false/);
  assert.match(matrix.body, /engine: \[chromium, webkit\]\n        part: \[mp4, flv-legacy, flv-enhanced, fmp4, ts, js-containers\]/);
  assert.match(matrix.body, /run: node scripts\/run-tests.mjs ci-analysis-matrix-\$\{\{ matrix.part \}\} --engine \$\{\{ matrix.engine \}\} --prepared/);
  assert.match(matrix.body, /if: always\(\)[\s\S]*name: analysis-matrix-reports-\$\{\{ matrix.engine \}\}-\$\{\{ matrix.part \}\}/);
  assert.match(matrix.body, /\.run\/test-suites\/ci-analysis-matrix-\$\{\{ matrix.part \}\}\//);
  assert.doesNotMatch(matrix.body, /continue-on-error:/);
  assert.match(jobs['analysis-browser'].body, /run: node scripts\/run-tests.mjs ci-analysis-ui --engine/);
  assert.doesNotMatch(jobs['analysis-browser'].body, /--case node-bitstream-analysis|run-tests.mjs ci-analysis-browser/);
  assert.match(jobs.unit.body, /run: node scripts\/run-tests.mjs ci-node-media/);
  for (const id of ['node-bitstream-analysis-core', 'node-bitstream-analysis-server', 'node-bitstream-analysis-flv']) {
    const manifest = JSON.parse(await readFile(new URL('../../scripts/testing/manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest.cases.find(row => row.id === id && row.required && row.suites.includes('unit')), `${id}: remains required in unit`);
  }
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

test('POSIX releases fix missing execute bits and private umask before archiving; extracted payload runs without chmod',
  { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-permissions-'));
    const name = 'voidplayer-linux-x64', directory = path.join(root, name), executable = path.join(directory, 'voidplayer');
    try {
      await mkdir(path.join(directory, 'dist'), { recursive: true });
      await writeFile(executable, '#!/bin/sh\nprintf permission-ready');
      await writeFile(path.join(directory, 'dist/index.html'), 'static content');
      await chmod(directory, 0o700); await chmod(path.join(directory, 'dist'), 0o700);
      await chmod(executable, 0o644); await chmod(path.join(directory, 'dist/index.html'), 0o600);
      await assert.rejects(verifyReleaseExecutablePermissions(executable, 'bun-linux-x64'), /0755/);
      const archive = path.join(root, name + '.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', root, name]);
      assert.throws(() => verifyReleaseArchivePermissions(archive, name, 'bun-linux-x64', 'voidplayer'), /0755/);
      // Owner-only execution can pass CI on the builder and still fail deployment.
      await chmod(executable, 0o700);
      await assert.rejects(verifyReleaseExecutablePermissions(executable, 'bun-linux-x64'), /0755/);
      await normalizeReleasePermissions(directory, 'bun-linux-x64', 'voidplayer');
      execFileSync('tar', ['-czf', archive, '-C', root, name]);
      verifyReleaseArchivePermissions(archive, name, 'bun-linux-x64', 'voidplayer');
      const extracted = path.join(root, 'extracted'); await mkdir(extracted);
      // POSIX tar may apply the extracting user's umask. Check the stored modes
      // independently and use ordinary extraction for the real execution check.
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const binary = path.join(extracted, name, 'voidplayer');
      await verifyReleaseExecutablePermissions(binary, 'bun-linux-x64');
      assert.equal(execFileSync(binary, [], { encoding: 'utf8' }), 'permission-ready');
      for (const folder of [directory, path.join(directory, 'dist')]) assert.equal((await stat(folder)).mode & 0o7777, 0o755);
      assert.equal((await stat(path.join(directory, 'dist/index.html'))).mode & 0o7777, 0o644);
      await chmod(executable, 0o6755);
      await normalizeReleasePermissions(directory, 'bun-darwin-arm64', 'voidplayer');
      await verifyReleaseExecutablePermissions(executable, 'bun-darwin-arm64');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

const locked = { bunVersion: '1.4.4', coreSource: { revision: 'b'.repeat(40) }, analysisSource: {revision:'c'.repeat(40)} };
async function makeSet(root        , mutate = (_     , __        ) => {}) {
  const directory = path.join(root, 'set'); await mkdir(directory, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot , 'System32', 'tar.exe') : 'tar';
  for (const platform of releasePlatforms) {
    const name = `voidplayer-0.1.0-${platform}`, folder = path.join(root, name);
    await mkdir(folder, { recursive: true });
    const manifest = { schema: 'voidplayer-release', version: 2, appVersion: '0.1.0', revision, dirty: false, target: `bun-${platform}`, runtime: { name: 'bun', version: locked.bunVersion }, decoder: { source: locked.coreSource }, analysis: {source:locked.analysisSource}, files: Object.fromEntries(['voidplayer-core.js', 'voidplayer-core.wasm', 'voidplayer-core-mt.js', 'voidplayer-core-mt.wasm', 'provenance.json', 'LICENSES/COPYING.LGPLv2.1', 'LICENSES/dav1d-COPYING'].map(f => [`dist/vendor/voidplayer-core/${f}`, sha256(f)]).concat(['voidplayer-analysis.js','voidplayer-analysis.wasm','voidplayer-analysis-mt.js','voidplayer-analysis-mt.wasm','threading.json','manifest.json','provenance.json','LICENSE'].map(f=>[`dist/vendor/voidplayer-analysis/${f}`,sha256(f)]))) };
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

test('draft preflight reads both committed core locks and rejects mismatched analysis provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voidplayer-draft-locks-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, '.bun-version'), locked.bunVersion + '\n');
    await writeFile(path.join(root, 'scripts/release-core.json'), JSON.stringify(locked.coreSource));
    const analysisLock = path.join(root, 'scripts/release-analysis.json');
    await writeFile(analysisLock, JSON.stringify(locked.analysisSource));
    const directory = await makeSet(root);
    assert.equal((await verifyDraftReleaseSet(root, directory, identity)).assets.length, 6);
    await writeFile(analysisLock, JSON.stringify({ revision: 'd'.repeat(40) }));
    await assert.rejects(verifyDraftReleaseSet(root, directory, identity), /analysis source matches lock/);
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

test('analysis preparation rejects provenance claiming references when actual exports are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-analysis-abi-'));
  try {
    const lock = JSON.parse(await readFile(new URL('../../scripts/release-analysis.json', import.meta.url), 'utf8'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({...lock, dirty:false, emscripten:`emcc ${lock.emscripten} verified`}));
    await writeFile(path.join(root, 'voidplayer-analysis.js'), 'export default async () => ({_vpa_abi: () => 1});');
    await writeFile(path.join(root, 'voidplayer-analysis.wasm'), new Uint8Array([0]));
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/prepare-analysis-core.mjs', import.meta.url)), root, path.join(root, 'output')], {stdio:'pipe'}),
      error => error.status === 1 && String(error.stderr).includes('reference ABI 1'));
    await assert.rejects(readFile(path.join(root, 'output/provenance.json')), {code:'ENOENT'});
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('core sync replaces both variants, drops stale unpinned metadata and preserves destination on failure', async () => {
  const { syncPlaybackCore, verifyCoreArtifact, playbackFiles } = await import('../../scripts/core-artifacts.mjs');
  const { verifyPlaybackOptimization } = await import('../../scripts/core-capabilities.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-core-sync-'));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  const lock = { revision: 'a'.repeat(40), ffmpegRef: 'test', optimization: { compile: '3', link: '2', lto: '1', simd: '1' } };
  try {
    await mkdir(source); await mkdir(target);
    const files = {};
    for (const name of playbackFiles) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      const bytes = Buffer.from(name.startsWith('voidplayer-ffmpeg-manifest')
        ? JSON.stringify({ optimization: lock.optimization }) : `new ${name}`);
      files[name] = sha256(bytes);
      await writeFile(path.join(source, name), bytes);
    }
    const provenance = { schema: 'voidplayer-core-build', source: lock, files };
    await writeFile(path.join(source, 'provenance.json'), JSON.stringify(provenance));
    await writeFile(path.join(target, 'voidplayer-core-mt.js'), 'old MT');
    await syncPlaybackCore(source, target, lock);
    assert.match(await readFile(path.join(target, 'voidplayer-core-mt.js'), 'utf8'), /^new /);
    await verifyCoreArtifact(target, lock, 'voidplayer-core-build', playbackFiles);
    for (const suffix of ['', '-mt']) {
      await verifyPlaybackOptimization(target, lock, suffix);
      await assert.rejects(verifyPlaybackOptimization(target, { optimization: { ...lock.optimization, lto: '0' } }, suffix),
        /Playback optimization differs from release lock/);
    }
    await writeFile(path.join(source, 'voidplayer-core-mt.js'), 'mismatched MT');
    await assert.rejects(syncPlaybackCore(source, target, lock), /bytes differ/);
    await verifyCoreArtifact(target, lock, 'voidplayer-core-build', playbackFiles);
    await assert.rejects(verifyCoreArtifact(target, {...lock,revision:'b'.repeat(40)}, 'voidplayer-core-build', playbackFiles), /release lock/);
    for (const name of ['provenance.json','voidplayer-core-mt.js','voidplayer-core-mt.wasm']) await rm(path.join(source, name));
    await syncPlaybackCore(source, target, lock);
    for (const name of ['provenance.json','voidplayer-core-mt.js','voidplayer-core-mt.wasm']) await assert.rejects(readFile(path.join(target, name)), {code:'ENOENT'});
    await writeFile(path.join(source, 'voidplayer-core-mt.js'), 'incomplete variant');
    await assert.rejects(syncPlaybackCore(source, target, lock), {code:'ENOENT'});
    assert.equal(await readFile(path.join(target, 'voidplayer-core.js'), 'utf8'), 'new voidplayer-core.js');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('raw upstream MT sync renames its unsuffixed build manifest',async()=>{
 const {syncPlaybackCore}=await import('../../scripts/core-artifacts.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'vp-raw-mt-sync-'));
 try{
  const source=path.join(root,'voidplayer-ffmpeg-wasm-test'),multi=path.join(root,'voidplayer-ffmpeg-wasm-mt-test'),target=path.join(root,'target');
  await mkdir(source);await mkdir(multi);
  for(const suffix of ['', '-mt']){const dir=suffix?multi:source;for(const ext of ['js','wasm'])await writeFile(path.join(dir,`voidplayer-core${suffix}.${ext}`),'fixture');await writeFile(path.join(dir,`capabilities${suffix}.json`),JSON.stringify({variant:suffix||'st'}));await writeFile(path.join(dir,'voidplayer-ffmpeg-manifest.json'),JSON.stringify({variant:suffix||'st'}));}
  await syncPlaybackCore(source,target,{ffmpegRef:'test'});
  assert.deepEqual(JSON.parse(await readFile(path.join(target,'voidplayer-ffmpeg-manifest.json'),'utf8')),{variant:'st'});
  assert.deepEqual(JSON.parse(await readFile(path.join(target,'voidplayer-ffmpeg-manifest-mt.json'),'utf8')),{variant:'-mt'});
  assert.deepEqual(JSON.parse(await readFile(path.join(target,'capabilities-mt.json'),'utf8')),{variant:'-mt'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('release rebuild sources include host type configurations and the offline app assets', async () => {
  const {selectReleaseSources}=await import('../../scripts/tools/release/source-files.mjs');
  const required=['shared/analysis/bitstream/runner.ts','shared/media/containers/flv-demux.ts','src/media/source.ts','server/app.ts','tsconfig.shared.json','tsconfig.json','package-lock.json',
    'tsconfig.browser.json','tsconfig.server.json','scripts/pwa/worker.js','public/manifest.webmanifest','public/icon-512.png'];
  const privateFiles=['.env','.run/data/library.sqlite','fixtures/video/private.mp4','artifacts/release.tar.gz','logs/report.json'];
  assert.deepEqual(selectReleaseSources([...required,...privateFiles,required[0]]),required);
});

test('every FATE consumer restores an exact manifest cache and verifies before saving or testing', async () => {
  const jobs = workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml',import.meta.url),'utf8'));
  const consumers = Object.entries(jobs).filter(([,job]) => job.body.includes('uses: ./.github/actions/fate-fixtures'));
  assert.deepEqual(consumers.map(([id])=>id).sort(), ['uncovered-regressions']);
  for(const [id,{body}] of consumers) {
    assert.equal((body.match(/uses: \.\/\.github\/actions\/fate-fixtures/g) ?? []).length,1,id);
    assert.doesNotMatch(body,/node scripts\/sync-fate-samples\.mjs/,id);
    assert.ok(body.indexOf('uses: ./.github/actions/fate-fixtures') < body.indexOf('run: node scripts/run-tests.mjs'),id);
  }
  const preparation = await readFile(new URL('../../.github/actions/media-fixtures/action.yml', import.meta.url), 'utf8');
  assert.equal((preparation.match(/uses: \.\/\.github\/actions\/fate-fixtures/g) ?? []).length, 1);
  for (const id of ['unit', 'cache-browser', 'playback']) assert.match(jobs[id].body, /uses: \.\/\.github\/actions\/media-fixtures/);
  const action = await readFile(new URL('../../.github/actions/fate-fixtures/action.yml',import.meta.url),'utf8');
  assert.match(action,/node scripts\/sync-fate-samples\.mjs --cache-key/);
  assert.match(action,/uses: actions\/cache\/restore@v4/);
  assert.doesNotMatch(action,/restore-keys:|continue-on-error:|always\(\)/);
  assert.equal((action.match(/key: \$\{\{ steps\.manifest\.outputs\.key \}\}/g) ?? []).length,2);
  assert.equal((action.match(/path: fixtures\/fate/g) ?? []).length,2);
  assert.match(action,/id: verify\n      shell: bash\n      run: node scripts\/sync-fate-samples\.mjs\n/,'cache hits must still be verified');
  assert.match(action,/if: success\(\) && steps\.verify\.outcome == 'success' && steps\.restore\.outputs\.cache-hit != 'true'\n      uses: actions\/cache\/save@v4/);
  assert.ok(action.indexOf('id: verify')>action.indexOf('uses: actions/cache/restore@v4'));
  assert.ok(action.indexOf('uses: actions/cache/save@v4')>action.indexOf('id: verify'));
});

test('daily and release sample consumers share one verified QA media artifact', async () => {
  const read = name => readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const prepare = await read('prepare-qa-media');
  assert.match(prepare, /run: bash scripts\/fetch-qa-media\.sh[\s\S]*uses: actions\/cache\/save@v4[\s\S]*name: qa-media/);
  const action = await readFile(new URL('../../.github/actions/qa-media/action.yml', import.meta.url), 'utf8');
  assert.match(action, /uses: actions\/download-artifact@v4[\s\S]*name: qa-media\n\s+path: fixtures\/video/);
  const mediaFixtures = await readFile(new URL('../../.github/actions/media-fixtures/action.yml', import.meta.url), 'utf8');
  assert.match(mediaFixtures, /uses: \.\/\.github\/actions\/qa-media/);
  assert.doesNotMatch(mediaFixtures, /lfs: true|sync-samples/);
  for (const [name, consumers] of [
    ['checks', ['unit']],
    ['release-preview', ['analysis-matrix', 'unit', 'playback', 'cache-browser', 'uncovered-regressions', 'hevc-browser', 'native-release']],
  ]) {
    const workflow = await read(name);
    const jobs = workflowJobs(workflow);
    assert.doesNotMatch(workflow, /lfs: true|sync-samples/);
    assert.match(jobs['qa-media'].body, /uses: \.\/\.github\/workflows\/prepare-qa-media\.yml/);
    assert.deepEqual(Object.keys(jobs).filter(id => /uses: \.\/\.github\/actions\/(?:qa-media|media-fixtures)/.test(jobs[id].body)), consumers);
    for (const id of consumers) assert.ok(jobs[id].needs.includes('qa-media'), id);
    assert.ok(!jobs.cores.needs.includes('qa-media'));
  }
});
