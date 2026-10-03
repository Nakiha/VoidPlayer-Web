import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';

import { browserEntries } from './testing/manifest.mjs';

export const browserRegressionSuites = Object.fromEntries(['uncovered', 'flv-startup'].map(suite => [suite, browserEntries(suite)]));

function terminateOwnedProcesses(child, grouped) {
  const failures = [];
  const kill = pid => {
    try { process.kill(pid, 'SIGKILL'); }
    catch (cause) { if (cause.code !== 'ESRCH') failures.push(cause.message); }
  };
  if (!child.pid) return failures;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, stdio: 'pipe' }); }
    catch (cause) { if (child.exitCode === null && child.signalCode === null) failures.push(cause.message); }
    return failures;
  }
  if (!grouped) { child.kill('SIGKILL'); return failures; }
  // Playwright deliberately creates detached browser process groups. Snapshot
  // the wrapper's descendants BEFORE killing it, while parentage proves which
  // processes belong to this case. Never kill by name or an unrelated group.
  let descendants = [];
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    let added;
    do {
      added = false;
      for (const [pid, ppid] of rows) if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); added = true; }
    } while (added);
    descendants = rows.filter(([pid]) => pid !== child.pid && owned.has(pid));
  } catch (cause) { failures.push(`process-tree snapshot: ${cause.message}`); }
  // Stop the wrapper first so it cannot create another browser during cleanup.
  // Each detached group leader must itself be a proven owned descendant.
  if (child.exitCode === null && child.signalCode === null) kill(-child.pid);
  for (const [pid, , pgid] of descendants) if (pid === pgid) kill(-pgid);
  for (const [pid] of descendants.reverse()) kill(pid);
  return failures;
}

async function runCase(entry, logPath, options) {
  // The parent owns this directory: even SIGKILL cannot bypass its teardown.
  // os.tmpdir(), Playwright profiles and nested workers inherit the same scope.
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vp-test-case-'));
  let result;
  try { result = await runOwnedCase(entry, logPath, { ...options, temporaryDirectory }); }
  catch (cause) { result = { exitCode: null, error: cause.message, durationMs: 0 }; }
  try {
    await options.removeTemporary(temporaryDirectory);
    result.temporaryDataRemoved = true;
  } catch (cause) {
    result.temporaryDataRemoved = false;
    result.cleanupErrors = [{ phase: 'temporary-data', message: cause.message }];
    const primary = result.error ?? (result.cancelled ? 'suite cancelled' : result.timedOut ? 'case timed out'
      : result.exitCode !== 0 ? `exit ${result.exitCode}` : 'case cleanup failed');
    result.error = `${primary}; temporary-data cleanup: ${cause.message}`;
  }
  return { ...result, phase: 'execute', temporaryDirectory };
}

async function runOwnedCase(entry, logPath, { cwd, timeoutMs, output, signal, directory, temporaryDirectory }) {
  const started = performance.now();
  let timedOut = false, cancelled = false, error = null;
  const log = createWriteStream(logPath);
  // Observe open/write errors immediately, not after the child has exited.
  const logFinished = finished(log, { cleanup: true }).catch(cause => { error = `log: ${cause.message}`; });
  const grouped = process.platform !== 'win32';
  const command = entry.args ? ['node', ...entry.args] : entry.command;
  const executable = command[0] === 'node' ? process.execPath : command[0];
  const child = spawn(executable, command.slice(1), { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...entry.env, TMPDIR: temporaryDirectory, TEMP: temporaryDirectory, TMP: temporaryDirectory,
      VOIDPLAYER_TEST_CASE: entry.id ?? entry.name, VOIDPLAYER_TEST_ARTIFACTS: path.resolve(directory, entry.name) } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (!log.destroyed) log.write(chunk); output.write(chunk); });
  const result = await new Promise(resolve => {
    let cleanupTimer, timer;
    const finish = result => { clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort); resolve(result); };
    const terminate = () => {
      const failures = terminateOwnedProcesses(child, grouped);
      if (failures.length) error = `termination: ${failures.join('; ')}`;
      // Even an escaped/reparented process or OS cleanup error must not retain
      // the pipes forever and hide every following script's result.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        error = [error, 'process/pipe cleanup exceeded 1000 ms'].filter(Boolean).join('; ');
        finish({ exitCode: child.exitCode, signal: child.signalCode });
      }, 1000);
    };
    const abort = () => { cancelled = true; terminate(); };
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', cause => { error = cause.message; });
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
  log.end(); await logFinished;
  return { ...result, timedOut, cancelled, error, durationMs: Math.round(performance.now() - started) };
}

// Each browser owns its process and result. One failing script must never hide
// later correctness checks; the aggregate exit status still gates the release.
export async function runBrowserRegressions(entries, {
  directory, cwd = process.cwd(), timeoutMs, output = process.stdout, signal, beforeCase,
  removeTemporary = directory => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
} = {}) {
  await mkdir(directory, { recursive: true });
  const results = [];
  const names = entries.map(entry => entry.name);
  if (new Set(names).size !== names.length || names.some(name => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error('Duplicate or unsafe case name');
  const report = () => ({ complete: results.length === entries.length, expectedCount: entries.length,
    passed: results.length === entries.length && results.every(result => result.required === false || result.status === 'passed'), results });
  const saveReport = async () => {
    const target = path.join(directory, 'results.json');
    await writeFile(target + '.tmp', JSON.stringify(report(), null, 2) + '\n');
    await rename(target + '.tmp', target);
  };
  await saveReport();
  for (const entry of entries) {
    const logPath = path.join(directory, `${entry.name}.log`);
    output.write(`::group::${entry.name}\n`);
    let result;
    try {
      if (signal?.aborted) result = { cancelled: true, error: 'suite cancelled', durationMs: 0, exitCode: null };
      else {
        await beforeCase?.(entry);
        result = await runCase(entry, logPath, { cwd, timeoutMs: timeoutMs ?? entry.timeoutMs ?? 300000, output, signal, directory, removeTemporary });
      }
    } catch (cause) {
      result = { error: cause.message, phase: 'prepare', durationMs: 0, exitCode: null };
      await writeFile(logPath, cause.stack + '\n');
    }
    const status = result.cancelled ? 'cancelled' : result.exitCode === 0 && !result.timedOut && !result.error ? 'passed' : 'failed';
    results.push({ ...entry, ...result, status, logPath });
    output.write(`::endgroup::\n${status.toUpperCase()} ${entry.name} (${result.durationMs} ms)\n`);
    // Flush after every script so partial evidence survives cancellation.
    await saveReport();
  }
  return report();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const suite = process.argv[2];
  if (!Object.hasOwn(browserRegressionSuites, suite ?? '')) throw new Error(`Unknown browser regression suite: ${suite}`);
  const report = await runBrowserRegressions(browserRegressionSuites[suite], { directory: `.run/browser-regressions/${suite}` });
  const failed = report.results.filter(result => result.status === 'failed');
  console.log(`Browser regressions: ${report.results.length - failed.length}/${report.results.length} passed`);
  for (const result of failed) console.error(`FAIL ${result.name}: ${result.error ?? (result.timedOut ? 'timed out' : `exit ${result.exitCode}, signal ${result.signal}`)}; ${result.logPath}`);
  if (!report.passed) process.exitCode = 1;
}
