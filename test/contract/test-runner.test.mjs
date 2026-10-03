import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBrowserRegressions } from '../../scripts/run-browser-regressions.mjs';
import { runTestSuite, parseOptions, suiteExitCode } from '../../scripts/run-tests.mjs';
import { prepareBuild } from '../../scripts/testing/build.mjs';
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
