import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { testManifest, selectCases, validateManifest } from '../../scripts/testing/manifest.mjs';
import { parseAnalysisOptions, analysisResponsibilities } from '../../scripts/testing/analysis/plan.mjs';
import { describeTestPlan } from '../../scripts/testing/execution-plan.mjs';
import { parseOptions } from '../../scripts/testing/options.mjs';
import { runAnalysisGroups } from '../../scripts/testing/analysis/run.mjs';
import { snapshotBuild } from '../../scripts/testing/build.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('served build snapshots survive later rebuilds and reject publication during capture', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vp-build-snapshot-'));
  try {
    const source = path.join(temp, 'dist'), target = path.join(temp, 'snapshot');
    await mkdir(source); await writeFile(path.join(source, 'worker.js'), 'original');
    await snapshotBuild(source, target);
    await writeFile(path.join(source, 'worker.js'), 'rebuilt');
    assert.equal(await readFile(path.join(target, 'worker.js'), 'utf8'), 'original');
    await assert.rejects(snapshotBuild(source, path.join(temp, 'raced'), {copy:async (...args) => {
      await writeFile(path.join(source, 'worker.js'), 'published while capturing'); await cp(...args);
    }}), /Frontend changed while taking a test snapshot/);
  } finally { await rm(temp, {recursive:true,force:true}); }
});

test('independent behavior failures aggregate but cancellation cannot start another group', async () => {
  const original = new Error('first failed'), seen = [];
  await assert.rejects(runAnalysisGroups(['first', 'second'], async group => {
    seen.push(group); if (group === 'first') throw original;
  }), error => error instanceof AggregateError && error.errors[0] === original);
  assert.deepEqual(seen, ['first', 'second']);
  const controller = new AbortController(), cancelled = new Error('cancelled'), active = [];
  await assert.rejects(runAnalysisGroups(['first', 'second'], async group => {
    active.push(group); controller.abort(cancelled); throw original;
  }, {signal:controller.signal}), error => error === cancelled);
  assert.deepEqual(active, ['first']);
});

test('Node CI partitions are disjoint and complete on every supported platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const ids = suite => selectCases({ suite, platform }).selected.map(row => row.id);
    const source = ids('source'), media = ids('ci-node-media');
    assert.deepEqual([...source, ...media].sort(), ids('unit').sort());
    assert.equal(new Set([...source, ...media]).size, source.length + media.length);
  }
  for (const mutation of ['missing', 'duplicate', 'outsider']) {
    const m = structuredClone(testManifest);
    const row = m.cases.find(row => row.suites.includes('ci-node-media'));
    if (mutation === 'missing') row.suites = row.suites.filter(suite => suite !== 'ci-node-media');
    if (mutation === 'duplicate') row.suites.push('source');
    if (mutation === 'outsider') row.suites = row.suites.filter(suite => suite !== 'unit');
    assert.throws(() => validateManifest(m), /Node CI partition|media CI partition/);
  }
});

test('legacy analysis modes have explicit independent responsibilities and reject ambiguous filters', () => {
  assert.deepEqual(parseAnalysisOptions([]).scenarios, ['matrix', 'diagrams', 'index']);
  const modes = { '--navigation-only': 'navigation', '--layout-only': 'layout', '--overlay-only': 'overlay', '--matrix-only': 'matrix', '--diagrams-only': 'diagrams', '--incremental-only': 'index' };
  for (const [flag, scenario] of Object.entries(modes)) {
    assert.deepEqual(parseAnalysisOptions(['chromium', flag]).scenarios, [scenario]);
    const spec = analysisResponsibilities[scenario];
    assert.ok(spec.purpose.length > 20);
    for (const stage of spec.stages) assert.ok(existsSync(new URL(`../../scripts/testing/analysis/scenarios/${stage}.mjs`, import.meta.url)));
  }
  for (const args of [['safari'], ['webkit','--typo'], ['webkit','--matrix-only','--diagrams-only'], ['webkit','--matrix-only','--matrix-part=unknown'], ['webkit','--matrix-only','--matrix-fixture='], ['webkit','--matrix-only','--matrix-part=mp4','--matrix-part=ts'], ['webkit','--matrix-only','--matrix-part=ts','--desktop-performance']]) assert.throws(() => parseAnalysisOptions(args));
});

test('every behavior stage is an importable function without starting a browser or generating media', async () => {
  const stages = new Set(Object.values(analysisResponsibilities).flatMap(spec => spec.stages));
  const files = readdirSync(new URL('../../scripts/testing/analysis/scenarios', import.meta.url)).filter(file => file.endsWith('.mjs'));
  assert.deepEqual(files.sort(), [...stages].map(stage => `${stage}.mjs`).sort(), 'every scenario must have a declared responsibility and execution path');
  for (const stage of stages) {
    const module = await import(`../../scripts/testing/analysis/scenarios/${stage}.mjs`);
    assert.equal(typeof module.run, 'function', stage);
  }
});

test('execution plans expose actual requirements without claiming unreviewed coverage', () => {
  const selection = selectCases({suite:'ci-analysis-ui', engine:'webkit'}), plan = describeTestPlan(selection);
  const index = plan.cases.find(row => row.id === 'browser-bitstream-analysis-index-webkit');
  assert.deepEqual(index.stages, ['index']); assert.equal(index.reviewNeeded, false);
  assert.match(index.responsibility, /cancellation/);
  assert.deepEqual(index.fixtures, selection.selected.find(row => row.id === index.id).fixtures);
  assert.equal(plan.summary.total, selection.selected.length);
  assert.equal(describeTestPlan({selected:[{id:'unreviewed',script:'test/unit/x.test.ts'}]}).cases[0].reviewNeeded, true);
  assert.equal(parseOptions(['unit','--plan','--platform','linux']).plan, true);
  for (const flag of ['--prepare', '--check', '--list']) assert.throws(() => parseOptions(['unit', '--plan', flag]), /inspection-only/);
  assert.deepEqual(parseAnalysisOptions(['chromium','--matrix-only','--matrix-part=ts','--desktop-performance']).scenarios,['matrix']);
});

test('generated analysis fixture profiles express dependencies rather than requiring every sample for every case', () => {
  assert.deepEqual(analysisResponsibilities.matrix.fixtures, []);
  for (const spec of Object.values(analysisResponsibilities)) {
    if (spec.fixtures.includes('queues')) assert.ok(spec.fixtures.includes('streams') && spec.fixtures.includes('incremental'));
    if (spec.fixtures.includes('index-flv')) assert.ok(spec.fixtures.includes('incremental'));
  }
  assert.equal(analysisResponsibilities.navigation.fixtures.includes('depths'), false);
  const workflow=readFileSync(new URL('../../.github/workflows/release-preview.yml',import.meta.url),'utf8');
  assert.match(workflow,/run-tests\.mjs source/);assert.match(workflow,/run-tests\.mjs ci-node-media/);
  assert.doesNotMatch(workflow,/run-tests\.mjs ci-analysis-logic/);
  for(const row of testManifest.cases.filter(row=>row.suites.includes('ci-analysis-logic')))assert.ok(row.suites.includes('source'),`${row.id}: analysis remains required in source`);
});
