import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withBrowserFixture } from '../../scripts/testing/browser-fixture.mjs';

async function scenario(body) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'vp-fixture-test-')),events=[];
  let temp;
  const page=new EventEmitter();
  Object.assign(page,{close:async()=>events.push('page'),isClosed:()=>false,evaluate:async()=>({positionUs:123}),screenshot:async()=>{},content:async()=>'<html>scene</html>',goto:async()=>{},waitForFunction:async()=>{}});
  const context={newPage:async()=>page,close:async()=>events.push('context')};
  const browser={newContext:async()=>context,close:async()=>events.push('browser')};
  const dependencies={makeTemp:async()=>{temp=await mkdtemp(path.join(os.tmpdir(),'vp-data-'));return temp;},removeTemp:async value=>{events.push('temp');await rm(value,{recursive:true,force:true});},startService:async()=>({server:{},url:'http://localhost/',close:async()=>events.push('server')}),launchBrowser:async()=>browser};
  const options={caseName:'fixture-test',engine:'webkit',directory,dependencies,cleanupTimeoutMs:100};
  try {await body({options,events,page,context,browser,dependencies,directory,getTemp:()=>temp});}
  finally {await rm(directory,{recursive:true,force:true});if(temp)await rm(temp,{recursive:true,force:true});}
}
test('normal fixture completion isolates data and closes every resource in reverse order',async()=>scenario(async({options,events,getTemp})=>{
  assert.equal(await withBrowserFixture(options,async fixture=>{await fixture.ready();return 'done';}),'done');
  assert.deepEqual(events,['page','context','browser','server','temp']);await assert.rejects(access(getTemp()));
}));
test('assertion failure retains original error, state/DOM and all cleanup errors',async()=>scenario(async({options,events,browser,directory})=>{
  const primary=new Error('assertion failed');browser.close=async()=>{events.push('browser');throw Error('close broke');};
  await assert.rejects(withBrowserFixture(options,async()=>{throw primary;}),error=>error===primary);
  assert.deepEqual(events,['page','context','browser','server','temp']);
  const report=JSON.parse(await readFile(path.join(directory,'fixture-test-failure.json'),'utf8'));
  assert.equal(report.error.message,'assertion failed');assert.equal(report.phase,'assertions');assert.equal(report.state.positionUs,123);
  assert.equal(await readFile(path.join(directory,'fixture-test-failure.html'),'utf8'),'<html>scene</html>');
  assert.match(await readFile(path.join(directory,'cleanup-errors.json'),'utf8'),/close broke/);
}));
test('browser launch and context creation failure still close previously acquired resources',async()=>{
  for(const stage of ['launch','context'])await scenario(async({options,events,browser,dependencies,directory})=>{
    if(stage==='launch')dependencies.launchBrowser=async()=>{throw Error('launch failure');};
    else browser.newContext=async()=>{throw Error('context failure');};
    await assert.rejects(withBrowserFixture(options,async()=>assert.fail('body ran')),new RegExp(stage+' failure'));
    assert.deepEqual(events,stage==='launch'?['server','temp']:['browser','server','temp']);
    const report=JSON.parse(await readFile(path.join(directory,'fixture-test-failure.json'),'utf8'));assert.equal(report.pageUnavailable,true);
  });
});
test('partial service acquisition can register cleanup before readiness and preserve startup error',async()=>scenario(async({options,events,dependencies})=>{
  dependencies.startService=async({defer})=>{defer('partial-service',async()=>events.push('partial'));throw Error('listen failed');};
  await assert.rejects(withBrowserFixture(options,async()=>{}),/listen failed/);assert.deepEqual(events,['partial','temp']);
}));
test('timeout during launch closes the service and a browser that arrives late',async()=>scenario(async({options,events,dependencies,browser,directory})=>{
  let release;dependencies.launchBrowser=()=>new Promise(resolve=>{release=()=>resolve(browser);});
  await assert.rejects(withBrowserFixture({...options,timeoutMs:40},async()=>assert.fail('body ran')),/browser-launch timed out/);
  assert.deepEqual(events,['server','temp']);release();await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(events,['server','temp','browser']);
  const report=JSON.parse(await readFile(path.join(directory,'fixture-test-failure.json'),'utf8'));assert.equal(report.phase,'browser-launch');
}));
test('cancellation while the body waits closes all resources and reports its phase',async()=>scenario(async({options,events,directory})=>{
  const controller=new AbortController();let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const running=withBrowserFixture({...options,signal:controller.signal},async fixture=>{entered();await fixture.phase('blocked-assertion',()=>new Promise(()=>{}));});
  await ready;controller.abort(new Error('cancelled by user'));
  await assert.rejects(running,/cancelled by user/);assert.deepEqual(events,['page','context','browser','server','temp']);
  const report=JSON.parse(await readFile(path.join(directory,'fixture-test-failure.json'),'utf8'));assert.equal(report.phase,'blocked-assertion');
}));
test('cleanup-only failures fail the fixture after every cleanup was attempted',async()=>scenario(async({options,events,browser,directory})=>{
  browser.close=async()=>{events.push('browser');throw Error('cleanup-only');};
  await assert.rejects(withBrowserFixture(options,async()=>{}),AggregateError);assert.deepEqual(events,['page','context','browser','server','temp']);
  const report=JSON.parse(await readFile(path.join(directory,'fixture-test-failure.json'),'utf8'));assert.equal(report.phase,'cleanup');
}));

test('extra contexts remain case-owned and close before the primary page and browser on failure', async () => scenario(async ({ options, events, browser }) => {
  const primary = new Error('secondary-context assertion');
  const original = browser.newContext;
  browser.newContext = async value => value?.extra ? { close: async () => events.push(value.extra) } : original();
  await assert.rejects(withBrowserFixture(options, async fixture => {
    await fixture.newContext({ extra: 'first-extra' });
    await fixture.newContext({ extra: 'second-extra' });
    throw primary;
  }), error => error === primary);
  assert.deepEqual(events, ['second-extra', 'first-extra', 'page', 'context', 'browser', 'server', 'temp']);
}));

test('an extra context arriving after cancellation is closed and cannot leak into the next case', async () => scenario(async ({ options, events, browser }) => {
  const controller = new AbortController(), original = browser.newContext;
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  browser.newContext = value => value?.extra ? new Promise(resolve => {
    release = () => resolve({ close: async () => events.push('late-context') }); started();
  }) : original();
  const running = withBrowserFixture({ ...options, signal: controller.signal }, fixture => fixture.newContext({ extra: true }));
  await entered; controller.abort(new Error('cancel extra context'));
  await assert.rejects(running, /cancel extra context/);
  assert.deepEqual(events, ['page', 'context', 'browser', 'server', 'temp']);
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.at(-1), 'late-context');
}));

test('completed ready and extra-context phases do not mislabel a later assertion failure', async () => scenario(async ({ options, directory }) => {
  await assert.rejects(withBrowserFixture(options, async fixture => {
    await fixture.ready();
    await fixture.newContext({});
    await fixture.phase('completed-operation', async () => {});
    throw new Error('later assertion');
  }), /later assertion/);
  const report = JSON.parse(await readFile(path.join(directory, 'fixture-test-failure.json'), 'utf8'));
  assert.equal(report.phase, 'assertions');
}));

test('late acquisition cleanup errors are persisted without replacing the timeout failure', async () => scenario(async ({ options, browser, dependencies, directory }) => {
  let release, closed;
  const cleanupFinished = new Promise(resolve => { closed = resolve; });
  browser.close = async () => { closed(); throw new Error('late close failed'); };
  dependencies.launchBrowser = () => new Promise(resolve => { release = () => resolve(browser); });
  await assert.rejects(withBrowserFixture({ ...options, timeoutMs: 40 }, async () => assert.fail('body ran')), /browser-launch timed out/);
  release(); await cleanupFinished;
  let report;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { report = JSON.parse(await readFile(path.join(directory, 'cleanup-errors.json'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(report.errors[0].error, 'late close failed');
  assert.match(report.errors[0].message, /late browser-launch cleanup failed/);
  assert.match(JSON.parse(await readFile(path.join(directory, 'fixture-test-failure.json'), 'utf8')).error.message, /timed out/);
}));

test('legacy direct CLI interrupt handlers cancel the fixture and are removed after teardown', async () => {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) await scenario(async ({ options, events, getTemp }) => {
    const previous = new Set(process.listeners(name)); let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const running = withBrowserFixture(options, async fixture => {
      entered(); await fixture.phase('direct-cli-wait', () => new Promise(() => {}));
    });
    await started;
    const handler = process.listeners(name).find(handler => !previous.has(handler));
    assert.equal(typeof handler, 'function');
    handler();
    await assert.rejects(running, new RegExp(`cancelled by ${name}`));
    assert.deepEqual(events, ['page', 'context', 'browser', 'server', 'temp']);
    await assert.rejects(access(getTemp()));
    assert.deepEqual(new Set(process.listeners(name)), previous);
  });
});
