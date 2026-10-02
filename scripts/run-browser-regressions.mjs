import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';

const browserCase = (script, engine) => ({
  name: `${script}-${engine ?? 'webkit'}`,
  args: [`scripts/${script}.mjs`, ...(engine ? [engine] : [])],
});

export const browserRegressionSuites = {
  uncovered: [
    ...['library', 'menu', 'metadata', 'timeline', 'theme', 'shortcuts', 'stepping', 'settings', 'saved-workspaces', 'admin']
      .map(name => browserCase(`check-${name}-browser`, 'chromium')),
    browserCase('check-media-open-matrix', 'chromium'),
    ...['workspace-link', 'workspace-list', 'color-settings'].map(name => browserCase(`check-${name}-browser`)),
    ...['check-annotation-browser', 'check-annotation-rendering', 'check-hlg-browser']
      .flatMap(script => ['chromium', 'webkit'].map(engine => browserCase(script, engine))),
  ],
  'flv-startup': ['chromium', 'webkit'].map(engine => browserCase('check-flv-startup-browser', engine)),
};

function terminateOwnedProcesses(child, grouped) {
  const failures = [];
  const kill = pid => {
    try { process.kill(pid, 'SIGKILL'); }
    catch (cause) { if (cause.code !== 'ESRCH') failures.push(cause.message); }
  };
  if (!grouped || !child.pid) { child.kill('SIGKILL'); return failures; }
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

async function runCase(entry, logPath, { cwd, timeoutMs, output }) {
  const started = performance.now();
  let timedOut = false, error = null;
  const log = createWriteStream(logPath);
  // Observe open/write errors immediately, not after the child has exited.
  const logFinished = finished(log, { cleanup: true }).catch(cause => { error = `log: ${cause.message}`; });
  const grouped = process.platform !== 'win32';
  const child = spawn(process.execPath, entry.args, { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (!log.destroyed) log.write(chunk); output.write(chunk); });
  const result = await new Promise(resolve => {
    let cleanupTimer;
    const finish = result => { clearTimeout(timer); clearTimeout(cleanupTimer); resolve(result); };
    const timer = setTimeout(() => {
      timedOut = true;
      const failures = terminateOwnedProcesses(child, grouped);
      if (failures.length) error = `termination: ${failures.join('; ')}`;
      // Even an escaped/reparented process or OS cleanup error must not retain
      // the pipes forever and hide every following script's result.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        error = [error, 'process/pipe cleanup exceeded 1000 ms'].filter(Boolean).join('; ');
        finish({ exitCode: child.exitCode, signal: child.signalCode });
      }, 1000);
    }, timeoutMs);
    child.on('error', cause => { error = cause.message; });
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
  });
  log.end(); await logFinished;
  return { ...result, timedOut, error, durationMs: Math.round(performance.now() - started) };
}

// Each browser owns its process and result. One failing script must never hide
// later correctness checks; the aggregate exit status still gates the release.
export async function runBrowserRegressions(entries, {
  directory, cwd = process.cwd(), timeoutMs = 300000, output = process.stdout,
} = {}) {
  await mkdir(directory, { recursive: true });
  const results = [];
  const report = () => ({ complete: results.length === entries.length, expectedCount: entries.length,
    passed: results.length === entries.length && results.every(result => result.status === 'passed'), results });
  const saveReport = () => writeFile(path.join(directory, 'results.json'), JSON.stringify(report(), null, 2) + '\n');
  await saveReport();
  for (const entry of entries) {
    const logPath = path.join(directory, `${entry.name}.log`);
    output.write(`::group::${entry.name}\n`);
    const result = await runCase(entry, logPath, { cwd, timeoutMs, output });
    const status = result.exitCode === 0 && !result.timedOut && !result.error ? 'passed' : 'failed';
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
