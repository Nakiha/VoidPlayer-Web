import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersion, readReleaseIdentity, readBuildIdentity, verifyFrontendIdentity, readReleaseNotes } from '../../scripts/release-version.mjs';
import { verifyReleaseSet, sha256, releasePlatforms } from '../../scripts/check-release-set.mjs';
import { stageRelease, verifyDraftReleaseSet } from '../../scripts/stage-release.mjs';
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
  assert.match(jobs['analysis-core'].body, /name: Verify analysis reference ABI including restored caches\n        run: node scripts\/prepare-analysis-core.mjs public\/vendor\/voidplayer-analysis/);
  const required = ['native-release', 'unit', 'playback', 'cache-browser', 'source-logic', 'analysis-browser', 'analysis-matrix', 'ssim-browser', 'hevc-browser', 'uncovered-regressions'];
  assert.deepEqual([...jobs['release-set'].needs].sort(), required.sort());
  assert.deepEqual(jobs.unit.needs, ['decoder', 'analysis-core']);
  assert.match(jobs.unit.body, /run: node scripts\/run-tests\.mjs ci-node-media\n        env:\n          VOIDPLAYER_FFMPEG_ORACLE:/);
  assert.equal((workflow.match(/run: node scripts\/run-tests\.mjs ci-node-media(?:\n|$)/g) ?? []).length, 1, 'media Node partition runs exactly once with no case filter');
  assert.doesNotMatch(jobs.playback.body, /run-tests\.mjs unit/);
  assert.match(jobs.unit.body, /if: always\(\)[\s\S]*name: media-node-reports[\s\S]*\.run\/test-suites\/ci-node-media\//);

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
  assert.match(informational.body, /cp scripts\/check-http-playback.mjs scripts\/bench-playback.mjs scripts\/test-certificate-trust.mjs/);
  assert.match(informational.body, /run: node scripts\/run-tests\.mjs ci-perf-pair --prepared/);
  assert.match(informational.body, /if: always\(\)[\s\S]*name: paired-https-performance-reports/);
  assert.doesNotMatch(informational.body, /stage-release|check-release-set|verified-release-set/);
  assert.deepEqual([...dependencies('release-set')].sort(), Object.keys(jobs).filter(id => !['release-set', 'release-draft', 'paired-https'].includes(id)).sort(),
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

test('cache suite runs once in its own required job with the same pinned preparation and evidence', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const jobs = workflowJobs(workflow), cache = jobs['cache-browser'];
  const manifest = JSON.parse(await readFile(new URL('../../scripts/testing/manifest.json', import.meta.url), 'utf8'));
  const cases = manifest.cases.filter(row => row.suites.includes('ci-cache'));
  assert.equal(cases.length, 58);
  assert.equal(new Set(cases.map(row => row.id )).size, 58);
  const expected=['browser-mcp-page-bridge-chromium','browser-sharing-webkit'];
  for(const engine of ['chromium','webkit']){
    for(const name of ['annotation-persistence','cache','library-discovery','native-presented-protocol','presented-quality','quality-annotation','quality-pair-view-10','task-center'])expected.push(`browser-${name}-${engine}`);
    for(const name of ['native-vmaf','native-xpsnr','native-cambi','quality-correspondence','quality-ranges','quality-roi','quality-workflow'])for(const depth of [8,10])expected.push(`browser-${name}-${depth}-${engine}`);
    for(const name of ['mp4-quality','mp4-vmaf'])for(const format of ['h264-8','hevc-8','hevc-10'])expected.push(`browser-${name}-${format}-${engine}`);
  }
  assert.deepEqual(cases.map(row=>row.id).sort(),expected.sort(),'exact prior54 plus four CAMBI checks; no silent removal/substitution');
  const protocolIds=['browser-native-presented-protocol-chromium','browser-native-presented-protocol-webkit'];
  const priorCases=cases.filter(row=>!protocolIds.includes(row.id));
  assert.equal(priorCases.length,56,'every prior cache case still runs with unchanged mandatory status on main/tag');
  const prCases=manifest.cases.filter(row=>row.suites.includes('ci-cache-pr'));
  assert.equal(prCases.length,57);
  assert.deepEqual(cases.filter(row=>!prCases.includes(row)).map(row=>row.id),['browser-presented-quality-webkit']);
  for(const engine of ['chromium','webkit']){
    const row=prCases.find(row=>row.id===`browser-native-presented-protocol-${engine}`);
    assert.deepEqual(row.command,['node','scripts/check-native-presented-protocol.mjs',engine]);
    assert.equal(row.required,true);assert.deepEqual(row.fixtures,['core']);assert.equal(row.timeoutMs,300000);
  }
  const taskIds=['browser-task-center-chromium','browser-task-center-webkit'];
  const taskCases=cases.filter(row=>taskIds.includes(row.id));
  assert.deepEqual(taskCases.map(row=>row.id).sort(),taskIds);
  for(const engine of ['chromium','webkit'])assert.deepEqual(taskCases.find(row=>row.id===`browser-task-center-${engine}`).command,['node','scripts/native/run-vmaf-tests.mjs','node','scripts/check-task-center-browser.mjs',engine]);
  const xpsnrIds=['browser-native-xpsnr-8-chromium','browser-native-xpsnr-10-chromium','browser-native-xpsnr-8-webkit','browser-native-xpsnr-10-webkit'];
  assert.deepEqual(cases.filter(row=>xpsnrIds.includes(row.id)).map(row=>row.id).sort(),[...xpsnrIds].sort());
  const prior=priorCases.filter(row=>!taskIds.includes(row.id)&&!xpsnrIds.includes(row.id));
  assert.equal(prior.length,50,'retain all prior required cache cases alongside task-center, XPSNR and CAMBI browsers');
  assert.deepEqual(prior.find(row=>row.id==='browser-mcp-page-bridge-chromium')?.command,['node','scripts/check-mcp-page-bridge-browser.mjs']);
  assert.equal(prior.filter(row=>row.id!=='browser-mcp-page-bridge-chromium').length,49,'retain the existing cache matrix alongside the required MCP case');
  assert.ok(cases.every(row => row.required && row.kind === 'regression'));
  assert.deepEqual(cache.needs, ['decoder', 'analysis-core']);
  assert.match(cache.body, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(cache.body, /^    timeout-minutes: 45$/m);
  assert.match(jobs.playback.body, /^    timeout-minutes: 45$/m);
  assert.doesNotMatch(cache.body, /strategy:|--engine|--stop-on-failure/);
  assert.equal((cache.body.match(/continue-on-error: true/g)??[]).length,1);
  const diagnostic=/      - name: Diagnostic only - WebKit multi-page paused native presentation\n([\s\S]*?)(?=      - )/.exec(cache.body)?.[1];
  assert.ok(diagnostic);assert.match(diagnostic,/id: webkit-paused-diagnostic\n        continue-on-error: true/);
  assert.match(diagnostic,/if: \$\{\{ github.event_name == 'pull_request' && !cancelled\(\) && steps.browser-inputs.outcome == 'success' \}\}/);
  assert.match(diagnostic,/run: node scripts\/run-tests\.mjs --case browser-presented-quality-webkit --prepared --directory \.run\/test-suites\/quality-browser-diagnostics/);
  assert.doesNotMatch(cache.body.replace(diagnostic,''),/continue-on-error:/,'no required suite or other case becomes informational');
  assert.match(cache.body,/name: Record non-blocking WebKit diagnostic outcome\n        if: \$\{\{ always\(\) && github.event_name == 'pull_request' \}\}/);
  assert.match(cache.body,/DIAGNOSTIC_OUTCOME: \$\{\{ steps.webkit-paused-diagnostic.outcome \}\}/,'report the actual outcome, not the continue-on-error conclusion');
  assert.equal((workflow.match(/run: node scripts\/run-tests\.mjs ci-cache --prepared\n/g) ?? []).length, 1);
  assert.doesNotMatch(jobs.playback.body, /ci-cache|annotation-cache-screenshots/);
  assert.deepEqual([...cache.body.matchAll(/^        run: node scripts\/run-tests\.mjs ([^\n]+)$/gm)].map(row => row[1]), ['--prepare', 'ci-cache --prepared', 'ci-cache-pr --prepared', '--case browser-presented-quality-webkit --prepared --directory .run/test-suites/quality-browser-diagnostics']);
  for(const [event,suite]of [['!=','ci-cache'],['==','ci-cache-pr']]){
    const condition="if: ${{ github.event_name "+event+" 'pull_request' && !cancelled() && steps.browser-inputs.outcome == 'success' }}";
    assert.ok(cache.body.includes(condition+'\n        run: node scripts/run-tests.mjs '+suite+' --prepared'));
  }

  const preparation = (body, end) => body.slice(body.indexOf('    steps:\n'), body.indexOf(`      - name: ${end}`));
  assert.equal(preparation(cache.body, 'Generate approximately 100 MB 1080p playback inputs'), preparation(jobs.playback.body, 'Verify opportunistic audio'),
    'same checkout, pinned core/QA/FATE/oracle, native tools, Playwright and verified build preparation');
  const fixtures = body => /      - name: Generate approximately 100 MB 1080p playback inputs\n[\s\S]*?(?=      - )/.exec(body)?.[0];
  assert.ok(fixtures(cache.body));
  assert.equal(fixtures(cache.body), fixtures(jobs.playback.body), 'preserve every preceding generated input');
  assert.match(cache.body, /if: always\(\)[\s\S]*name: annotation-cache-screenshots/);
  for (const artifact of ['/tmp/voidplayer-annotation-*.png', '/tmp/voidplayer-caches-*.png', '.run/workspace-sharing-browser-*/', '.run/test-suites/ci-cache/', '.run/test-suites/ci-cache-pr/', '.run/test-suites/quality-browser-diagnostics/', '.run/test-suites/preparation/', '.run/test-suites/build-receipt.json', '.run/playback-reports/']) {
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
  assert.deepEqual(matrix.needs, ['decoder', 'analysis-core']);
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-core-sync-'));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  const lock = { revision: 'a'.repeat(40), ffmpegRef: 'test' };
  try {
    await mkdir(source); await mkdir(target);
    const files = {};
    for (const name of playbackFiles) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      const bytes = Buffer.from(`new ${name}`); files[name] = sha256(bytes);
      await writeFile(path.join(source, name), bytes);
    }
    const provenance = { schema: 'voidplayer-core-build', source: lock, files };
    await writeFile(path.join(source, 'provenance.json'), JSON.stringify(provenance));
    await writeFile(path.join(target, 'voidplayer-core-mt.js'), 'old MT');
    await syncPlaybackCore(source, target, lock);
    assert.match(await readFile(path.join(target, 'voidplayer-core-mt.js'), 'utf8'), /^new /);
    await verifyCoreArtifact(target, lock, 'voidplayer-core-build', playbackFiles);
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

test('release rebuild sources include shared implementations and their independent type configuration', async () => {
  const {selectReleaseSources}=await import('../../scripts/tools/release/source-files.mjs');
  const required=['quality.html','shared/analysis/bitstream/runner.ts','shared/media/containers/flv-demux.ts','src/media/source.ts','server/app.ts','tsconfig.shared.json','tsconfig.json','package-lock.json','examples/http-quality.mjs'];
  const privateFiles=['.env','.run/data/library.sqlite','fixtures/video/private.mp4','artifacts/release.tar.gz','logs/report.json'];
  assert.deepEqual(selectReleaseSources([...required,...privateFiles,required[0]]),required);
});

test('every FATE consumer restores an exact manifest cache and verifies before saving or testing', async () => {
  const jobs = workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml',import.meta.url),'utf8'));
  const consumers = Object.entries(jobs).filter(([,job]) => job.body.includes('uses: ./.github/actions/fate-fixtures'));
  assert.deepEqual(consumers.map(([id])=>id).sort(), ['cache-browser','playback','uncovered-regressions','unit']);
  for(const [id,{body}] of consumers) {
    assert.equal((body.match(/uses: \.\/\.github\/actions\/fate-fixtures/g) ?? []).length,1,id);
    assert.doesNotMatch(body,/node scripts\/sync-fate-samples\.mjs/,id);
    assert.ok(body.indexOf('uses: ./.github/actions/fate-fixtures') < body.indexOf('run: node scripts/run-tests.mjs'),id);
  }
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

test('SSIM dual-browser real task/evidence checks gate release output without extending serial source UI budgets',async()=>{
 const jobs=workflowJobs(await readFile(new URL('../../.github/workflows/release-preview.yml',import.meta.url),'utf8'));
 const ssim=jobs['ssim-browser'];assert.deepEqual(ssim.needs,['decoder','analysis-core']);assert.match(ssim.body,/engine: \[chromium, webkit\]/);
 assert.match(ssim.body,/run: node scripts\/run-tests\.mjs ci-ssim --engine \$\{\{ matrix.engine \}\}/);
 assert.match(ssim.body,/if: always\(\)[\s\S]*ssim-browser-reports-/);assert.ok(jobs['release-set'].needs.includes('ssim-browser'));
 assert.doesNotMatch(ssim.body,/continue-on-error:/);
});
