import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { browserRegressionSuites, runBrowserRegressions } from '../../scripts/run-browser-regressions.mjs';
import { observeTimelineProgress } from '../../scripts/timeline-progress.mjs';
import { withinBrowserPhase, recordBrowserEvidence, saveBrowserFailure } from '../../scripts/browser-failure-evidence.mjs';
import { trackChildShutdown } from '../../scripts/testing/lifecycle.mjs';
import { assertCachedDisplayReuse } from '../../scripts/testing/analysis/display-reuse.mjs';

test('a health poll inside display/hover reproduces the old total-count failure without new analysis', () => {
  const base = 'http://127.0.0.1:43210/', state = [{ state: 'ready', counters: { open: 1, step: 12, products: 1 } }];
  const requests = [{ method: 'GET', url: base + 'assets/overlay.js' }], baseline = requests.length;
  requests.push({ method: 'GET', url: base + 'api/health' });
  assert.throws(() => assert.equal(requests.length, baseline), /2 !== 1/, 'the original assertion deterministically mistakes unrelated polling for new block data');
  const evidence = assertCachedDisplayReuse(requests, baseline, base, state, structuredClone(state));
  assert.equal(evidence.health.length, 1); assert.equal(evidence.unexpected.length, 0);
});

test('display guard rejects every non-health request and new local analysis work', () => {
  const base = 'http://127.0.0.1:43210/', state = [{ state: 'ready', counters: { open: 1, step: 12, products: 1 } }];
  const health = { method: 'GET', url: base + 'api/health' };
  for (const request of [
    { method: 'POST', url: base + 'api/media/id/bitstream-analysis/requests' },
    { method: 'GET', url: base + 'api/bitstream-analysis/requests/task' },
    { method: 'GET', url: base + 'assets/local-worker.js' },
    { method: 'GET', url: base + 'api/media/id' },
    { method: 'HEAD', url: health.url }, { method: 'POST', url: health.url },
    { method: 'GET', url: health.url + '?probe=1' }, { method: 'GET', url: health.url + '/extra' },
    { method: 'GET', url: 'http://127.0.0.1:43211/api/health' },
  ]) assert.throws(() => assertCachedDisplayReuse([health, request], 0, base, state, state), /reuse the existing block data/);
  assert.throws(() => assertCachedDisplayReuse([health], 0, base, state, [{ state: 'pending' }]), /start no analysis task/);
  assert.throws(() => assertCachedDisplayReuse([health], 0, base, state, [{ state: 'ready', counters: { ...state[0].counters, open: 2 } }]), /start no analysis task/);
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, signals: [] });
  child.kill = signal => { child.signals.push(signal); return true; };
  return child;
}

test('native cleanup waits for close after exit and also observes close before stop', async () => {
  for (const alreadyClosed of [false, true]) {
    const child = fakeChild(), stop = trackChildShutdown(child);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    if (alreadyClosed) child.emit('close', 0, null);
    let settled = false;
    const pending = stop().then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, alreadyClosed);
    assert.deepEqual(child.signals, [], 'already exited child must not be signalled');
    if (!alreadyClosed) child.emit('close', 0, null);
    assert.deepEqual(await pending, { pid: 123, code: 0, signal: null });
    assert.equal(await stop(), await pending, 'repeat stop observes the same owned close');
  }
});

test('native cleanup signals its owned child and keeps waiting through exit', async () => {
  const child = fakeChild(), stop = trackChildShutdown(child);
  const pending = stop();
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  assert.deepEqual(await pending, { pid: 123, code: null, signal: 'SIGTERM' });
});

test('forced native cleanup remains a failed case even when SIGKILL closes the child', async () => {
  const child = fakeChild(), stop = trackChildShutdown(child, { graceMs: 5, killMs: 20 });
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') { child.signalCode = signal; child.emit('close', null, signal); }
    return true;
  };
  await assert.rejects(stop(), /shutdown timed out.*closed during cleanup.*signal=SIGKILL/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('missing native close fails within the cleanup budget and spawn errors are retained', async () => {
  const child = fakeChild(), stop = trackChildShutdown(child, { graceMs: 5, killMs: 5 });
  await assert.rejects(stop(), /close still missing after 5 ms cleanup/);
  const failed = fakeChild(), stopFailed = trackChildShutdown(failed);
  const original = new Error('spawn failed');
  failed.emit('error', original);
  failed.emit('close', -2, null);
  await assert.rejects(stopFailed(), error => error === original);
});

const silent = { write() {} };
test('failed timeline still runs every later HLG/annotation engine and fails the aggregate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-suite-'));
  try {
    const entries = browserRegressionSuites.uncovered.map(entry => ({ ...entry, args: ['-e', `console.log(${JSON.stringify(entry.name)}); process.exit(${entry.name === 'check-timeline-browser-chromium' ? 7 : 0})`] }));
    const result = await runBrowserRegressions(entries, { directory, output: silent });
    assert.equal(result.passed, false);
    assert.equal(result.results.length, entries.length);
    assert.equal(result.results.find(row => row.name === 'check-timeline-browser-chromium').exitCode, 7);
    for (const script of ['check-annotation-browser', 'check-annotation-rendering', 'check-hlg-browser']) for (const engine of ['chromium', 'webkit']) {
      const row = result.results.find(row => row.name === `${script}-${engine}`);
      assert.equal(row.status, 'passed');
      assert.match(await readFile(row.logPath, 'utf8'), new RegExp(row.name));
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')), result);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timed-out process records a failed result and subsequent scripts still run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-timeout-'));
  try {
    const result = await runBrowserRegressions([
      { name: 'blocked', args: ['-e', 'setInterval(() => {}, 1000)'] },
      { name: 'following', args: ['-e', 'console.log("ran")'] },
    ], { directory, output: silent, timeoutMs: 500 });
    assert.equal(result.passed, false); assert.equal(result.results[0].timedOut, true);
    assert.equal(result.results[1].status, 'passed');
    assert.deepEqual(browserRegressionSuites['flv-startup'].map(row => row.args.at(-1)), ['chromium', 'webkit']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the workflow CLI exits nonzero after retaining both FLV engine results', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-cli-'));
  try {
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'scripts/check-flv-startup-browser.mjs'), 'console.log(process.argv[2]); process.exit(process.argv[2] === "chromium" ? 7 : 0);\n');
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/run-browser-regressions.mjs', import.meta.url)), 'flv-startup'],
      { cwd: directory, stdio: 'pipe' }), error => error.status === 1);
    const report = JSON.parse(await readFile(path.join(directory, '.run/browser-regressions/flv-startup/results.json'), 'utf8'));
    assert.equal(report.passed, false); assert.deepEqual(report.results.map(row => row.status), ['failed', 'passed']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unfinished all-passing prefix is explicitly incomplete, never a passed suite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-partial-'));
  let running;
  try {
    running = runBrowserRegressions([{ name: 'first', args: ['-e', 'console.log("first")'] },
      { name: 'second', args: ['-e', 'setTimeout(()=>console.log("second"),500)'] }], { directory, output: silent });
    let partial;
    for (const started = performance.now(); performance.now() - started < 2000;) {
      partial = await readFile(path.join(directory, 'results.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (partial?.results.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(partial.results.length, 1); assert.equal(partial.results[0].status, 'passed');
    assert.equal(partial.complete, false); assert.equal(partial.expectedCount, 2); assert.equal(partial.passed, false);
    const complete = await running;
    assert.equal(complete.complete, true); assert.equal(complete.expectedCount, 2); assert.equal(complete.passed, true);
  } finally { await running; await rm(directory, { recursive: true, force: true }); }
});

for (const detached of [false, true]) test(`timed-out ${detached ? 'detached' : 'same-group'} browser descendants cannot retain pipes and hide the next result`, { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-descendant-'));
  let timer, descendantPid;
  try {
    const pidFile = path.join(directory, 'descendant.pid');
    const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${detached},stdio:['ignore',process.stdout,process.stderr]}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
    const result = await Promise.race([
      runBrowserRegressions([{ name: 'descendant', args: ['-e', script] }, { name: 'following', args: ['-e', 'console.log("ran")'] }], { directory, output: silent, timeoutMs: 500 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('descendant retained output pipes')), 3000); }),
    ]);
    descendantPid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(result.results[0].timedOut, true); assert.equal(result.results[1].status, 'passed');
    assert.equal(result.results[0].error, null, 'owned descendants close their pipes without needing the cleanup fallback');
    // A killed orphan may briefly remain as a zombie until the container init
    // reaps it; it must never still be a running detached browser.
    const state = process.platform === 'linux' ? await readFile(`/proc/${descendantPid}/stat`, 'utf8').catch(() => '') : '';
    if (state) assert.equal(state.slice(state.lastIndexOf(')') + 2).split(' ')[0], 'Z');
  } finally {
    clearTimeout(timer);
    // Also clean up when a future regression fails the bounded test itself.
    descendantPid ??= Number(await readFile(path.join(directory, 'descendant.pid'), 'utf8').catch(() => '0'));
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(directory, { recursive: true, force: true });
  }
});

test('an early log stream error records failure without aborting later scripts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-log-error-'));
  try {
    await mkdir(path.join(directory, 'unwritable.log'));
    const result = await runBrowserRegressions([{ name: 'unwritable', args: ['-e', 'console.log("first")'] }, { name: 'following', args: ['-e', 'console.log("second")'] }], { directory, output: silent });
    assert.equal(result.passed, false); assert.match(result.results[0].error, /log:/); assert.equal(result.results[1].status, 'passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fakePlayback(change = sample => sample, frameInterval = 1200) {
  let time = 0, id = 0;
  const cancelled = new Set(), timers = new Map();
  return {
    now: () => time,
    read: () => {
      const position = 1850000 + Math.floor(time / frameInterval) * 33333;
      return change({ position, value: position, ratio: position / 10000000, short: Math.min(position, 1966666), long: position, playing: true });
    },
    request: callback => {
      const key = ++id;
      queueMicrotask(() => {
        if (cancelled.has(key)) return;
        time += 16;
        for (const [timer, { at, callback }] of timers) if (at <= time) { timers.delete(timer); callback(); }
        if (!cancelled.has(key)) callback();
      });
      return key;
    },
    cancel: key => cancelled.add(key),
    later: (callback, ms) => { const key = ++id; timers.set(key, { at: time + ms, callback }); return key; },
    clear: key => timers.delete(key),
  };
}
const observation = { max: 10000000, afterEndUs: 2100000 };

test('slow renderer passes exact UI and EOF checks based on decoded progress, without a throughput floor', async () => {
  const report = await observeTimelineProgress(observation, fakePlayback());
  assert.ok(report.elapsedMs > 1000);
  assert.ok(report.distinctPositions / report.sampleCount < .7, 'fixture fails the old wall-window ratio');
  const afterEnd = report.samples.filter(row => row.position > 2100000);
  assert.ok(afterEnd.length > 2);
  assert.equal(new Set(afterEnd.map(row => row.short)).size, 1);
  assert.equal(new Set(afterEnd.map(row => row.long)).size, 3);
});

test('stalled decoded frames fail within the no-progress bound even if the session clock advances', async () => {
  await assert.rejects(observeTimelineProgress(observation, fakePlayback(sample => ({ ...sample, long: 1850000 }))), /did not advance for 5000 ms/);
});

test('frozen session/UI progress fails even while long-track decoded frames continue after EOF', async () => {
  await assert.rejects(observeTimelineProgress(observation, fakePlayback(sample => {
    const long = 1850000 + Math.round((sample.long - 1850000) / 33333) * 100000;
    const position = Math.min(long, 2150000);
    return { ...sample, long, position, value: position, ratio: position / observation.max };
  }, 16)), /session clock and focused timeline did not advance for 5000 ms/);
});

test('stale UI updates fail rather than weakening presentation alignment', async () => {
  await assert.rejects(observeTimelineProgress(observation, fakePlayback(sample => ({ ...sample, value: 1850000 }), 16)), /does not follow the actual presentation PTS/);
  await assert.rejects(observeTimelineProgress(observation, fakePlayback(sample => ({ ...sample, playing: false }))), /playback stopped/);
});

test('no animation callbacks and insufficient EOF progress both have bounded failure', async () => {
  await assert.rejects(observeTimelineProgress({ ...observation, timeoutMs: 20 }, { request: () => 1, cancel() {} }), /within 20 ms/);
  await assert.rejects(observeTimelineProgress({ ...observation, timeoutMs: 1000 }, fakePlayback()), /within 1000 ms/);
});

test('FLV load, zero seek and uncovered seek timeouts identify the engine, case and target', async () => {
  for (const [phase, targetPtsUs] of [['load', 0], ['seek-to-zero', 0], ['seek-uncovered-region', 2500000]]) {
    await assert.rejects(withinBrowserPhase(() => new Promise(() => {}), 5,
      { engine: 'webkit', caseName: 'blocked-tail-startup', phase, targetPtsUs }),
    error => error.message.includes(`webkit blocked-tail-startup: ${phase}`) && error.message.includes(`target PTS ${targetPtsUs}`));
  }
});

test('failure scene retains index state, Range summary and original error when screenshot capture fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-evidence-'));
  try {
    const page = new EventEmitter(), evidence = recordBrowserEvidence(page);
    const request = { headers: () => ({ range: 'bytes=65536-131071' }), url: () => 'http://localhost/api/media/test', method: () => 'GET' };
    page.emit('request', request);
    page.isClosed = () => false;
    page.evaluate = async () => ({ positionUs: 0, busy: true, tracks: [{ indexState: 'building', indexWaiting: true, frame: { ptsUs: 0 } }] });
    page.screenshot = async () => { throw new Error('page crashed'); };
    page.content = async () => '<html>failure scene</html>';
    const reportPath = await saveBrowserFailure({ page, directory, name: 'flv-webkit', context: { phase: 'seek-to-zero', targetPtsUs: 0 }, error: new Error('original timeout'), evidence });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.error.message, 'original timeout'); assert.equal(report.state.tracks[0].indexState, 'building');
    assert.equal(report.rangeRequests.pending, 1); assert.equal(report.rangeRequests.recent[0].range, 'bytes=65536-131071');
    assert.match(report.screenshotError, /page crashed/); assert.equal(await readFile(reportPath.replace('.json', '.html'), 'utf8'), '<html>failure scene</html>');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a fixture or browser launch failure still persists a scene without a page', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vp-browser-no-page-'));
  try {
    const reportPath = await saveBrowserFailure({ directory, name: 'flv-webkit', context: { engine: 'webkit', caseName: 'startup', phase: 'browser-launch' }, error: new Error('launch failed') });
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.pageUnavailable, true); assert.equal(report.phase, 'browser-launch'); assert.equal(report.error.message, 'launch failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('network evidence is bounded while totals and pending counts survive eviction', () => {
  const page = new EventEmitter(), evidence = recordBrowserEvidence(page), requests = [];
  for (let i = 0; i < 150; i++) {
    const request = { headers: () => ({ range: 'bytes=0-99' }), url: () => `http://localhost/api/media/${i}`, method: () => 'GET', failure: () => ({ errorText: 'aborted' }) };
    requests.push(request); page.emit('request', request);
    page.emit('pageerror', new Error(`failure-${i}`));
  }
  page.emit('requestfinished', requests[0]);
  page.emit('requestfailed', requests[1]);
  // Duplicate terminal events must not decrement pending twice.
  page.emit('requestfinished', requests[1]);
  const report = evidence();
  assert.equal(report.rangeRequests.total, 150); assert.equal(report.rangeRequests.pending, 148);
  assert.equal(report.apiRequests.total, 150); assert.equal(report.apiRequests.pending, 148);
  assert.equal(report.rangeRequests.recent.length, 100); assert.equal(report.pageErrors.length, 100);
  assert.equal(report.failedRequests[0].error, 'aborted');
  page.emit('requestfinished', requests[149]);
  assert.equal(report.apiRequests.pending, 148, 'a saved snapshot does not mutate with later events');
});

test('non-Range API failures and failed static assets appear in evidence without request bodies', () => {
  const page = new EventEmitter(), evidence = recordBrowserEvidence(page);
  const api = { headers: () => ({}), url: () => 'http://localhost/api/workspaces', method: () => 'POST' };
  const asset = { headers: () => ({}), url: () => 'http://localhost/assets/app.js', method: () => 'GET', failure: () => ({ errorText: 'connection reset' }) };
  page.emit('request', api); page.emit('response', { request: () => api, status: () => 409, headers: () => ({}) }); page.emit('requestfinished', api);
  page.emit('request', asset); page.emit('requestfailed', asset);
  const report = evidence();
  assert.equal(report.apiRequests.total, 1); assert.equal(report.apiRequests.pending, 0);
  assert.equal(report.rangeRequests.total, 0);
  assert.deepEqual(report.failedRequests.map(row => row.status ?? row.error), [409, 'connection reset']);
  assert.equal('body' in report.apiRequests.recent[0], false);
});
