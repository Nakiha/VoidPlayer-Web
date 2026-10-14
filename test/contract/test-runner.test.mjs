import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBrowserRegressions } from '../../scripts/run-browser-regressions.mjs';
import { runTestSuite, parseOptions, suiteExitCode } from '../../scripts/run-tests.mjs';
import { prepareBuild, buildFingerprint } from '../../scripts/testing/build.mjs';
const silent = { write() {} };
const entry = (id, code, extra = {}) => ({ id, name: id, command: ['node','-e',code], required: true, build: false, tools: [], fixtures: [], restrictions: [], ...extra });
async function temporary(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-runner-'));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('required failure gates aggregate; independent cases still finish and informational failures stay visible', async () => temporary(async directory => {
  const report = await runBrowserRegressions([entry('failed','process.exit(7)'),entry('next','console.log("next")'),entry('info','process.exit(9)',{required:false})], { directory, output: silent });
  assert.equal(report.complete, true); assert.equal(report.passed, false);
  assert.deepEqual(report.results.map(row => row.status), ['failed','passed','failed']);
  const info = await runBrowserRegressions([entry('info','process.exit(9)',{required:false})], { directory, output: silent });
  assert.equal(info.passed,true); assert.equal(info.results[0].exitCode,9);
  assert.equal(suiteExitCode(info),1,'standalone informational suites retain failure status for CI warnings');
  assert.equal(suiteExitCode({passed:true,results:[{required:true,status:'passed'},{required:false,status:'failed'}]}),0);
}));
test('cancellation kills active descendants, records pending cases and cannot pass', async () => temporary(async directory => {
  const controller = new AbortController();
  const pid = path.join(directory,'started');
  const running = runBrowserRegressions([entry('active',`require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid)); setInterval(()=>{},1000)`),entry('pending','process.exit(0)')], { directory, output: silent, signal: controller.signal });
  try {
    let started;
    for (let n=0;n<200;n++) { started = await readFile(pid,'utf8').catch(()=>null); if(started)break; await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.ok(started); controller.abort();
    const report = await running;
    assert.equal(report.passed,false); assert.deepEqual(report.results.map(row=>row.status),['cancelled','cancelled']);
    assert.throws(()=>process.kill(Number(started),0));
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'results.json'),'utf8')),report);
  } finally { controller.abort(); await running; }
}));
test('failed prerequisite and spawn failures retain later independent results', async () => temporary(async directory => {
  const report = await runBrowserRegressions([entry('prepare','process.exit(0)'),entry('spawn','',{command:['vp-executable-that-does-not-exist']}),entry('later','process.exit(0)')], { directory, output: silent, beforeCase: row=>{if(row.id==='prepare')throw Error('missing fixture');} });
  assert.deepEqual(report.results.map(row=>row.status),['failed','failed','passed']);
  assert.equal(report.results[0].phase,'prepare'); assert.match(report.results[1].error,/ENOENT/);
}));
test('suite builds once for multiple cases, and a broken build does not hide source-only checks', async () => temporary(async directory => {
  const selected=[entry('a','process.exit(0)',{build:true}),entry('b','process.exit(0)',{build:true}),entry('source','process.exit(0)')];
  let builds=0;
  const passed=await runTestSuite({selected,excluded:[]},{directory,output:silent,build:async()=>{builds++;}});
  assert.equal(passed.passed,true);assert.equal(builds,1);
  const failed=await runTestSuite({selected,excluded:[]},{directory,output:silent,build:async()=>{throw Error('build failed');}});
  assert.deepEqual(failed.results.map(row=>row.status),['failed','failed','passed']);
}));
test('selected derived fixtures prepare once, verify every output, and never run base downloads', async () => temporary(async root => {
  await writeFile(path.join(root, 'source.mp4'), 'source');
  await writeFile(path.join(root, 'first.flv'), 'already present');
  const fixtures = {
    derived: { paths: ['first.flv', 'last.flv'], inputs: ['source.mp4'], prepareOnDemand: true,
      prepare: ['node', '-e', 'const fs=require("node:fs");fs.appendFileSync("prepares","1");fs.writeFileSync("last.flv","generated");'] },
    base: { paths: ['missing-base'], prepare: ['node', '-e', 'require("node:fs").writeFileSync("downloaded","bad")'] },
  };
  const selected = [entry('derived-a', 'process.exit(0)', {fixtures:['derived']}), entry('derived-b', 'process.exit(0)', {fixtures:['derived']})];
  const options = { root, directory: path.join(root, 'reports'), output: silent, fixtures };
  assert.equal((await runTestSuite({selected, excluded:[]}, options)).passed, true);
  assert.equal(await readFile(path.join(root, 'prepares'), 'utf8'), '1', 'partial fixtures are regenerated only once');
  assert.equal((await runTestSuite({selected, excluded:[]}, options)).passed, true);
  assert.equal(await readFile(path.join(root, 'prepares'), 'utf8'), '1', 'complete fixtures need no preparation');
  await assert.rejects(readFile(path.join(root, 'downloaded')), {code:'ENOENT'});
  const failed = await runTestSuite({selected:[entry('base', '', {fixtures:['base']})], excluded:[]}, options);
  assert.equal(failed.passed, false); assert.match(failed.results[0].error, /Missing fixture base/);
  await assert.rejects(readFile(path.join(root, 'downloaded')), {code:'ENOENT'}, 'base preparation remains explicit');
}));
test('missing derived inputs and incomplete successful generators fail without hiding independent cases', async () => temporary(async root => {
  const fixture = { paths:['output.flv'], inputs:['source.mp4'], prepareOnDemand:true,
    prepare:['node', '-e', 'require("node:fs").appendFileSync("prepares","1")'] };
  const options = {root, directory:path.join(root, 'reports'), output:silent, fixtures:{derived:fixture}};
  const selected = [entry('dependent-a', '', {fixtures:['derived']}), entry('dependent-b', '', {fixtures:['derived']}), entry('independent', '')];
  const missing = await runTestSuite({selected, excluded:[]}, options);
  assert.deepEqual(missing.results.map(row => row.status), ['failed', 'failed', 'passed']);
  assert.match(missing.results[0].error, /Missing input for fixture derived: source.mp4/);
  await assert.rejects(readFile(path.join(root, 'prepares')), {code:'ENOENT'});
  await writeFile(path.join(root, 'source.mp4'), 'source');
  const incomplete = await runTestSuite({selected, excluded:[]}, options);
  assert.deepEqual(incomplete.results.map(row => row.status), ['failed', 'failed', 'passed']);
  assert.match(incomplete.results[0].error, /Missing fixture derived: output.flv/);
  assert.equal(await readFile(path.join(root, 'prepares'), 'utf8'), '1');
  fixture.prepare = ['node', '-e', 'require("node:fs").appendFileSync("prepares","2");process.exit(7)'];
  const failed = await runTestSuite({selected, excluded:[]}, options);
  assert.deepEqual(failed.results.map(row => row.status), ['failed', 'failed', 'passed']);
  assert.match(failed.results[0].error, /Fixture derived preparation failed/);
  assert.equal(await readFile(path.join(root, 'prepares'), 'utf8'), '12');
  const evidence = JSON.parse(await readFile(path.join(root, 'reports/fixtures/derived/results.json'), 'utf8'));
  assert.equal(evidence.results[0].exitCode, 7);
}));
test('cancellation terminates an active fixture generator and preserves its report', async () => temporary(async root => {
  await writeFile(path.join(root, 'source.mp4'), 'source');
  const controller = new AbortController();
  const fixtures = {derived:{paths:['output.flv'], inputs:['source.mp4'], prepareOnDemand:true,
    prepare:['node', '-e', 'require("node:fs").writeFileSync("pid",String(process.pid));console.log("fixture-started");setInterval(()=>{},1000)']}};
  const report = await runTestSuite({selected:[entry('dependent', '', {fixtures:['derived']})], excluded:[]}, {
    root, directory:path.join(root, 'reports'), fixtures, signal:controller.signal,
    output:{write(chunk) {if (String(chunk).includes('fixture-started')) controller.abort();}},
  });
  assert.equal(report.passed, false);
  const pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0));
  const evidence = JSON.parse(await readFile(path.join(root, 'reports/fixtures/derived/results.json'), 'utf8'));
  assert.equal(evidence.passed, false); assert.equal(evidence.results[0].status, 'cancelled');
  assert.equal(evidence.results[0].timeoutMs, 300000, 'fixture preparation has its own bounded watchdog');
}));
test('verified receipt reuses exactly one build and rejects changed source/configuration/output', async () => temporary(async root => {
  await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/main.ts'),'original');
  const marker=path.join(root,'builds');
  const command=['node','-e',`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify('build\n')});fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','built')`];
  const options={root,directory:path.join(root,'reports'),output:silent,command};
  await prepareBuild(options);await prepareBuild({...options,prepared:true});
  assert.equal(await readFile(marker,'utf8'),'build\n');
  await writeFile(path.join(root,'src/main.ts'),'changed');
  await assert.rejects(prepareBuild({...options,prepared:true}),/stale/);
  await prepareBuild(options);await writeFile(path.join(root,'dist/index.html'),'tampered');
  await assert.rejects(prepareBuild({...options,prepared:true}),/stale/);
}));
test('empty selections and unknown CLI options fail rather than produce an all-passing empty report', async () => {
  await assert.rejects(runTestSuite({selected:[],excluded:[]}),/No applicable/);
  for(const args of [['--wat'],['browser','--engine'],['browser','--platform','linux']])assert.throws(()=>parseOptions(args));
  assert.deepEqual(parseOptions(['browser','--case','browser-menu-webkit','--prepared']).caseIds,['browser-menu-webkit']);
});

test('parent removes exclusive temporary data after normal, failed and forcibly timed-out child processes', async () => temporary(async directory => {
  const code = 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");console.log(os.tmpdir());fs.writeFileSync(path.join(os.tmpdir(),"owned"),"case data");';
  const report = await runBrowserRegressions([
    entry('normal-temp', code), entry('failed-temp', code + 'process.exit(7);'),
    entry('timed-out-temp', code + 'setInterval(()=>{},1000);', { timeoutMs: 500 }),
    entry('after-temp-timeout', code),
  ], { directory, output: silent });
  assert.equal(report.complete, true); assert.equal(report.passed, false);
  assert.deepEqual(report.results.map(row => row.status), ['passed', 'failed', 'failed', 'passed']);
  assert.equal(report.results[1].exitCode, 7); assert.equal(report.results[2].timedOut, true);
  assert.equal(new Set(report.results.map(row => row.temporaryDirectory)).size, 4);
  for (const row of report.results) {
    assert.equal(row.phase, 'execute');
    assert.equal(row.temporaryDataRemoved, true);
    assert.ok((await readFile(row.logPath, 'utf8')).includes(row.temporaryDirectory));
    await assert.rejects(readFile(path.join(row.temporaryDirectory, 'owned')), { code: 'ENOENT' });
  }
}));

test('cancelled child data is removed by its parent even when the child has no cleanup handler', async () => temporary(async directory => {
  const controller = new AbortController(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const running = runBrowserRegressions([entry('cancel-temp', 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");fs.writeFileSync(path.join(os.tmpdir(),"owned"),"data");console.log("ready-to-cancel");setInterval(()=>{},1000);')], {
    directory, signal: controller.signal, output: { write(chunk) { if (String(chunk).includes('ready-to-cancel')) entered(); } },
  });
  await started; controller.abort(new Error('cancel test'));
  const report = await running;
  assert.equal(report.passed, false); assert.equal(report.results[0].status, 'cancelled');
  assert.equal(report.results[0].temporaryDataRemoved, true);
  await assert.rejects(readFile(path.join(report.results[0].temporaryDirectory, 'owned')), { code: 'ENOENT' });
}));

test('parent temporary cleanup failure retains the child exit and every following independent result', async () => temporary(async directory => {
  const report = await runBrowserRegressions([entry('cleanup-primary', 'process.exit(7)'), entry('cleanup-next', 'process.exit(0)')], {
    directory, output: silent, removeTemporary: async () => { throw new Error('injected temporary cleanup failure'); },
  });
  try {
    assert.equal(report.complete, true); assert.equal(report.passed, false);
    assert.equal(report.results[0].exitCode, 7);
    assert.match(report.results[0].error, /^exit 7; temporary-data cleanup:/);
    assert.equal(report.results[1].exitCode, 0); assert.equal(report.results[1].status, 'failed');
    for (const row of report.results) assert.equal(row.cleanupErrors[0].message, 'injected temporary cleanup failure');
  } finally {
    for (const row of report.results) await rm(row.temporaryDirectory, { recursive: true, force: true });
  }
}));


test('prepared builds distinguish tagged releases from previews', async () => temporary(async root => {
  const previous = process.env.VOIDPLAYER_RELEASE_TAG;
  try {
    delete process.env.VOIDPLAYER_RELEASE_TAG;
    const preview = await buildFingerprint(root);
    process.env.VOIDPLAYER_RELEASE_TAG = 'v1.2.3';
    assert.notEqual(await buildFingerprint(root), preview);
    const tagged = await buildFingerprint(root);
    process.env.VOIDPLAYER_RELEASE_TAG = 'v1.2.3-rc.1';
    assert.notEqual(await buildFingerprint(root), tagged);
  } finally {
    if (previous === undefined) delete process.env.VOIDPLAYER_RELEASE_TAG;
    else process.env.VOIDPLAYER_RELEASE_TAG = previous;
  }
}));

function presentationApi(slots = ['A']) {
  const tokens = new Map(slots.map(slot => [slot, { slot, generation: 1, commit: 1, normalizedMediaUs: 0, sourcePtsUs: 1000, timeMapping: 'source-microseconds-minus-first-pts',
    picture: { sourceVersion: `fixture-${slot}@v1`, stream: 'video', configuration: 0, au: 0, layer: 0, picture: 0, field: 'frame' } }]));
  const state = { error: null, busy: false, playing: false, positionUs: 0,
    tracks: slots.map(slot => ({ slot, id: `fixture-${slot}`, sourceGen: 1, frame: { ptsUs: 0 } })) };
  const listeners = new Set();
  const api = {
    getState: () => structuredClone(state),
    tools: [{ name: 'get_presented_frame', execute: ({ slot }) => structuredClone(tokens.get(slot)) }],
    subscribePresentedFrames(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    play() { state.playing = true; }, pause() { state.playing = false; },
  };
  return { api, state, tokens, listeners, present(slot = 'A', patch = {}) {
    const before = tokens.get(slot), token = { ...before, commit: before.commit + 1, normalizedMediaUs: 40000, sourcePtsUs: 41000,
      picture: { ...before.picture, au: 1 }, ...patch };
    tokens.set(slot, token); state.tracks.find(track => track.slot === slot).frame.ptsUs = token.normalizedMediaUs;
    state.positionUs = token.normalizedMediaUs;
    for (const listener of listeners) listener(slot, structuredClone(token));
  } };
}
const settlePresentation = () => new Promise(resolve => setImmediate(resolve));

async function presentationGate(t, fixture, options = {}) {
  const { waitForPlaybackPresentation } = await import('../../scripts/testing/playback-presentation.mjs');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  return { pending: waitForPlaybackPresentation({ api: fixture.api, clock: { now: () => Date.now() }, ...options }) };
}

test('slow correct presentation passes independently while the original 2-second performance report stays failed', async t => {
  const { assertBenchmarkCorrectness } = await import('../../scripts/testing/playback-presentation.mjs');
  const fixture = presentationApi();
  const report = { requestedWallMs: 2000, error: null, staleAfterPause: false, passed: false,
    failures: ['below-realtime', 'A:no-frames', 'A:presentation-stall'], measurements: { tracks: { A: { drawn: 0 } } } };
  const original = structuredClone(report);
  assert.throws(() => assert.ok(report.measurements.tracks.A.drawn > 0), 'old fixed-window draw gate rejects this slow but correct case');
  assert.throws(() => assert.equal(report.passed, true), 'old absolute startup gate also rejects it');
  assertBenchmarkCorrectness(report);
  const { pending } = await presentationGate(t, fixture);
  await settlePresentation(); t.mock.timers.tick(2500); fixture.present(); await settlePresentation();
  t.mock.timers.tick(100); const result = await pending;
  assert.ok(result.elapsedMs >= 2500); assert.equal(result.presentations.length, 1); assert.equal(result.pauseStable, true);
  assert.deepEqual(report, original); assert.equal(report.passed, false); assert.equal(fixture.state.playing, false); assert.equal(fixture.listeners.size, 0);
});

test('permanent no-frame and repeated same-picture events never reset the progress watchdog', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture, { idleMs: 300, totalMs: 900, pollMs: 50 });
  const rejected = assert.rejects(pending, /no strict frame progress/); await settlePresentation();
  for (let n = 0; n < 3; n++) { t.mock.timers.tick(90); fixture.present('A', { normalizedMediaUs: 0, sourcePtsUs: 1000, picture: fixture.tokens.get('A').picture }); await settlePresentation(); }
  t.mock.timers.tick(30); await rejected;
  assert.equal(fixture.state.playing, false); assert.equal(fixture.listeners.size, 0);
});

for (const invalid of ['source', 'generation', 'time-mapping', 'same-picture', 'timestamp', 'commit']) {
  test(`functional presentation rejects ${invalid} instead of accepting a draw count`, async t => {
    const fixture = presentationApi(), { pending } = await presentationGate(t, fixture);
    const rejected = assert.rejects(pending); await settlePresentation();
    const before = fixture.tokens.get('A');
    const patch = invalid === 'source' ? { picture: { ...before.picture, sourceVersion: 'wrong@v2', au: 1 } }
      : invalid === 'generation' ? { generation: 2 }
      : invalid === 'time-mapping' ? { sourcePtsUs: 99999 }
      : invalid === 'same-picture' ? { picture: before.picture }
      : invalid === 'timestamp' ? { sourcePtsUs: null } : { commit: NaN };
    fixture.present('A', patch); await rejected;
    assert.equal(fixture.state.playing, false); assert.equal(fixture.listeners.size, 0);
  });
}

test('late presentation after pause fails even if it redraws the same timestamp', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture);
  const rejected = assert.rejects(pending, /Late presentation after pause/); await settlePresentation();
  fixture.present(); await settlePresentation(); assert.equal(fixture.state.playing, false);
  const token = fixture.tokens.get('A'); fixture.present('A', { normalizedMediaUs: token.normalizedMediaUs, sourcePtsUs: token.sourcePtsUs });
  await rejected; assert.equal(fixture.listeners.size, 0);
});

test('cancellation rejects and cleans listeners; a late callback cannot turn it into success', async t => {
  const fixture = presentationApi(), controller = new AbortController();
  const { pending } = await presentationGate(t, fixture, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled by caller/); await settlePresentation();
  const late = [...fixture.listeners][0]; controller.abort(new Error('cancelled by caller')); await rejected;
  late('A', { ...fixture.tokens.get('A'), commit: 2, normalizedMediaUs: 40000, sourcePtsUs: 41000 });
  await settlePresentation(); assert.equal(fixture.state.playing, false); assert.equal(fixture.listeners.size, 0);
});

test('total watchdog remains bounded while other tracks make strict progress', async t => {
  const fixture = presentationApi(['A', 'B']), { pending } = await presentationGate(t, fixture, { idleMs: 120, totalMs: 150, pollMs: 10 });
  const rejected = assert.rejects(pending, /total timeout/); await settlePresentation();
  t.mock.timers.tick(80); fixture.present('A'); await settlePresentation();
  t.mock.timers.tick(70); await rejected; assert.equal(fixture.listeners.size, 0);
});

test('a synchronous slow callback cannot bypass an already elapsed watchdog', async t => {
  const fixture = presentationApi();
  let wall = 0;
  const { pending } = await presentationGate(t, fixture, { idleMs: 300, totalMs: 900, clock: { now: () => wall } });
  const rejected = assert.rejects(pending, /no strict frame progress/); await settlePresentation();
  wall = 400; fixture.present(); await rejected; assert.equal(fixture.listeners.size, 0);
});

test('benchmark timing reports remain informational but correctness and unknown failures still reject', async () => {
  const { assertBenchmarkCorrectness } = await import('../../scripts/testing/playback-presentation.mjs');
  const report = failures => ({ error: null, staleAfterPause: false, failures });
  assertBenchmarkCorrectness(report(['below-realtime', 'insufficient-sample', 'frame-lag', 'track-skew', 'pause-latency', 'H:presentation-stall', 'A:no-frames']));
  for (const failure of ['page-not-visible', 'media-changed', 'interrupted', 'premature-end', 'playback-error', 'stale-frame-after-pause', 'unknown-failure']) assert.throws(() => assertBenchmarkCorrectness(report([failure])));
  assert.throws(() => assertBenchmarkCorrectness({ ...report([]), error: 'decoder failed' }));
  assert.throws(() => assertBenchmarkCorrectness({ ...report([]), staleAfterPause: true }));
});

test('permanent absence of presentation events fails and releases the subscribed observer', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture, { idleMs: 300, totalMs: 900, pollMs: 50 });
  const rejected = assert.rejects(pending, /no strict frame progress/); await settlePresentation();
  t.mock.timers.tick(300); await rejected; assert.equal(fixture.state.playing, false); assert.equal(fixture.listeners.size, 0);
});

test('slow intermediate strict frames renew progress without turning the requested media span into a speed floor', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture, { idleMs: 500, totalMs: 2000, minAdvanceUs: 100000, pollMs: 50 });
  await settlePresentation();
  for (let au = 1; au <= 4; au++) {
    t.mock.timers.tick(300); fixture.present('A', { normalizedMediaUs: au * 30000, sourcePtsUs: 1000 + au * 30000, picture: { ...fixture.tokens.get('A').picture, au } }); await settlePresentation();
  }
  t.mock.timers.tick(100); const result = await pending;
  assert.equal(result.presentations[0].successor.normalizedMediaUs, 120000); assert.ok(result.elapsedMs >= 1200); assert.equal(fixture.listeners.size, 0);
});

test('cache workload retains its playing duration and permits subsequent strict frames before pause', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture, { minPlayingMs: 60 });
  await settlePresentation(); fixture.present(); await settlePresentation(); assert.equal(fixture.state.playing, true);
  t.mock.timers.tick(40); fixture.present('A', { normalizedMediaUs: 80000, sourcePtsUs: 81000, picture: { ...fixture.tokens.get('A').picture, au: 2 } }); await settlePresentation();
  t.mock.timers.tick(20); await settlePresentation(); assert.equal(fixture.state.playing, false);
  t.mock.timers.tick(100); const result = await pending; assert.equal(result.playingMs, 60); assert.equal(result.elapsedMs, 160);
});

test('a blocked page evaluator is bounded by the independent host watchdog', async t => {
  await import('../../scripts/browser-failure-evidence.mjs');
  const { verifyPlaybackPresentation } = await import('../../scripts/testing/playback-presentation.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = verifyPlaybackPresentation({ evaluate: () => new Promise(() => {}) }, { totalMs: 10 }, { engine: 'fake', caseName: 'blocked-page' });
  const rejected = assert.rejects(pending, /timed out after 5010 ms/); await settlePresentation();
  t.mock.timers.tick(5010); await rejected;
});

test('regressive frames cannot keep an unfinished media-span verification alive', async t => {
  const fixture = presentationApi(), { pending } = await presentationGate(t, fixture, { minAdvanceUs: 100000 });
  const rejected = assert.rejects(pending, /regressed/); await settlePresentation(); fixture.present(); await settlePresentation();
  fixture.present('A', { normalizedMediaUs: 20000, sourcePtsUs: 21000, picture: { ...fixture.tokens.get('A').picture, au: 2 } });
  await rejected; assert.equal(fixture.listeners.size, 0);
});
