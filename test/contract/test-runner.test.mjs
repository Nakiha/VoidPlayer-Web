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
