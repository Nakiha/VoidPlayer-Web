import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testManifest, validateManifest, selectCases, validateCiBrowserCoverage } from '../../scripts/testing/manifest.mjs';

const clone = () => structuredClone(testManifest);
test('every existing test and check has an explicit registration or explained tool classification', () => assert.equal(validateManifest(), true));
test('manifest rejects duplicate IDs, dangling paths, unknown suites/engines and missing gate declarations', () => {
  for (const mutate of [
    m => m.suites.push(m.suites[0]), m => { m.cases[0].script = 'test/../outside.test.ts'; },
    m => m.cases.push(m.cases[0]), m => { m.cases[0].script = 'test/missing.test.ts'; },
    m => { m.cases[0].suites.push('unknown'); }, m => { m.cases[0].engines = ['safari']; },
    m => { delete m.cases[0].required; }, m => { m.cases[0].kind = 'tool'; },
    m => { m.cases[0].implementation = 'scripts/testing/browser/missing.mjs'; },
    m => { m.cases[0].implementation = 'scripts/testing/browser/../outside.mjs'; },
    m => { m.cases.find(row => row.kind === 'diagnostic').restrictions = []; },
    m => { m.cases.find(row => row.suites.includes('fast')).fixtures = ['core']; },
  ]) { const manifest = clone(); mutate(manifest); assert.throws(() => validateManifest(manifest)); }
});
test('new checks cannot silently escape registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-manifest-'));
  try {
    await mkdir(path.join(root, 'test')); await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'test/unregistered.test.ts'), '');
    assert.throws(() => validateManifest({ ...testManifest, cases: [] }, root), /Unregistered check/);
    await rm(path.join(root, 'test/unregistered.test.ts'));
    await mkdir(path.join(root, 'scripts/testing/browser/ui'), { recursive: true });
    await writeFile(path.join(root, 'scripts/testing/browser/ui/unregistered.mjs'), '');
    assert.throws(() => validateManifest({ ...testManifest, cases: [] }, root), /Unregistered check: scripts\/testing\/browser/);
    await rm(path.join(root, 'scripts/testing/browser/ui/unregistered.mjs'));
    await mkdir(path.join(root, 'scripts/tools/perf'), { recursive: true });
    await writeFile(path.join(root, 'scripts/tools/perf/unregistered.mjs'), '');
    assert.throws(() => validateManifest({ ...testManifest, cases: [] }, root), /Unregistered check: scripts\/tools\/perf/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Node implementations have one classified owner while every old command remains registered', () => {
  const owners = new Map();
  for (const row of testManifest.cases.filter(row => row.script.startsWith('test/'))) {
    assert.match(row.implementation, /^test\/(unit|contract|media)\/[^/]+\.test\.(ts|mjs)$/);
    const prior = owners.get(row.implementation);
    assert.ok(!prior || prior === row.script, `${row.id}: two commands would execute the same implementation twice`);
    owners.set(row.implementation, row.script);
  }
  assert.ok(owners.size >= 127, 'retain every original Node implementation; new registered cases may be added');
  for (const name of ['flv-fixture.ts', 'http-request.ts', 'packet-fixture.ts', 'range-bridge-worker.ts']) {
    const source = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    assert.ok(source.includes(`'./helpers/${name}'`), `${name}: old helper or worker URL no longer forwards`);
    assert.ok(readFileSync(new URL('../helpers/' + name, import.meta.url), 'utf8').length > 0);
  }
});
test('coverage floor retains original commands, required cells and CI membership', () => {
  const baseline = JSON.parse(readFileSync(new URL('.././testing-coverage-baseline.json', import.meta.url), 'utf8'));
  for (const cell of baseline) {
    const row = testManifest.cases.find(row => row.id === cell.id);
    assert.ok(row, `lost case ${cell.id}`);
    for (const key of ['script', 'command', 'engines', 'platforms', 'inputs', 'required', 'env']) assert.deepEqual(row[key], cell[key], `${cell.id}: changed ${key}`);
    for (const suite of cell.ci) assert.ok(row.suites.includes(suite), `${cell.id}: removed from ${suite}`);
  }
});
test('local and CI select the same applicable matrix; filters cannot fake engine/input support', () => {
  const linux = selectCases({ suite: 'uncovered', platform: 'linux' }).selected;
  assert.equal(linux.length, 36);
  assert.deepEqual(linux.map(row => row.id), selectCases({ suite: 'uncovered', platform: 'darwin' }).selected.map(row => row.id));
  assert.equal(selectCases({ suite: 'browser', engine: 'webkit', input: 'local' }).selected.filter(row => row.id.startsWith('hevc-timeline')).length, 1);
  const windows = selectCases({ suite: 'ci-native-console', platform: 'darwin' });
  assert.equal(windows.selected.length, 0); assert.match(windows.excluded[0].reason, /platform darwin/);
  for (const query of [{ suite: 'typo' }, { caseIds: ['missing'] }, { suite: 'browser', engine: 'safari' }, { suite: 'browser', platform: 'unknown' }]) assert.throws(() => selectCases(query));
});
test('CI uses the catalog for required suites and keeps platform/input matrices and informational gates', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  for (const suite of ['ci-analysis-logic','ci-analysis-browser','ci-playback','ci-cache','ci-flv','flv-startup','ci-fate','ci-https','ci-perf','uncovered','ci-native-node','ci-native-bun','ci-native-http','ci-native-https','ci-native-console']) {
    assert.match(workflow, new RegExp(`scripts/run-tests\\.mjs ${suite}(?: |\\n)`));
    assert.ok(selectCases({ suite, platform: suite === 'ci-native-console' ? 'win32' : 'linux' }).selected.length);
  }
  assert.doesNotMatch(workflow, /npm run (?:test:|build|release)/);
  assert.match(workflow, /engine: \[chromium, webkit\][\s\S]*input: \[local, remote\]/);
  for (const platform of ['linux-x64','windows-x64','darwin-arm64']) assert.ok(workflow.includes(platform));
  assert.equal(testManifest.cases.find(row => row.id === 'https-playback-benchmark').required, false);
  assert.equal(testManifest.cases.find(row => row.id === 'https-playback-functional').required, true);
});

test('single-engine scripts cannot be advertised as a different browser matrix', () => {
  for (const row of testManifest.cases) {
    if (!row.script.startsWith('scripts/')) continue;
    const source = readFileSync(new URL('../../' + (row.implementation ?? row.script), import.meta.url), 'utf8');
    const imports = /import\s*\{([^}]+)\}\s*from\s*['"]playwright['"]/.exec(source)?.[1].split(',').map(name => name.trim());
    if (!imports) continue;
    for (const engine of row.engines.filter(engine => ['chromium','webkit'].includes(engine))) {
      assert.ok(imports.includes(engine), `${row.id}: does not import ${engine}`);
    }
  }
});

test('compatibility entries point to registered domain implementations without changing CLI behavior', () => {
  for (const row of testManifest.cases.filter(row => row.implementation)) {
    const entry = readFileSync(new URL('../../' + row.script, import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '').trim();
    const match = /^(?:import|export \* from) ['"]([^'"]+)['"];?$/.exec(entry);
    assert.ok(match, `${row.id}: entry must only load its implementation`);
    assert.equal(new URL(match[1], new URL('../../' + row.script, import.meta.url)).href,
      new URL('../../' + row.implementation, import.meta.url).href);
  }
});

test('identity source checks require no downloaded core, media or browser build', () => {
  for (const row of selectCases({ suite: 'ci-identity-unit' }).selected) {
    assert.deepEqual(row.fixtures, [], `${row.id}: identity unit job does not download fixtures`);
    assert.equal(row.build, false);
    assert.deepEqual(row.engines, ['node']);
  }
});


test('every required browser cell is selected by an actual CI suite or expanded engine/input matrix', () => {
  const workflows = ['release-preview.yml', 'identity.yml'].map(file => readFileSync(new URL('../../.github/workflows/' + file, import.meta.url), 'utf8'));
  assert.equal(validateCiBrowserCoverage(workflows), true);
  const missing = clone(); missing.cases.find(row => row.id === 'browser-library-webkit').suites = ['browser'];
  assert.throws(() => validateCiBrowserCoverage(workflows, missing), /browser-library-webkit/);
  const lostMatrix = workflows.map(source => source.replace('engine: [chromium, webkit]\n        input: [local, remote]', 'engine: [chromium]\n        input: [local, remote]'));
  assert.throws(() => validateCiBrowserCoverage(lostMatrix), /hevc-timeline-webkit/);
  const lostInput = workflows.map(source => source.replace('input: [local, remote]', 'input: [remote]'));
  assert.throws(() => validateCiBrowserCoverage(lostInput), /hevc-timeline-.*-local/);
});
test('all source-only Node checks run before media dependencies are prepared', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-preview.yml', import.meta.url), 'utf8');
  const job = workflow.split('  source-logic:\n')[1].split('\n  analysis-logic:')[0];
  assert.doesNotMatch(job, /needs:|playwright install|sync-samples|download-artifact/);
  assert.match(job, /run-tests\.mjs source/);
  const eligible = testManifest.cases.filter(row => row.kind === 'regression' && row.suites.includes('unit') && !row.fixtures.length && !row.tools.length && !row.build && row.engines.join() === 'node');
  assert.deepEqual(selectCases({ suite: 'source' }).selected.map(row => row.id), eligible.map(row => row.id));
  const missing = clone(); missing.cases.find(row => row.id === 'node-workspace-storage').suites = ['unit'];
  assert.throws(() => validateManifest(missing), /missing from source suite/);
});
