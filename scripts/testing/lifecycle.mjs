// Preserve the primary exception while attempting every registered teardown.
export async function cleanupResources(steps, failure, report = console.error, label = 'Browser fixture') {
  const errors = [];
  for (const [name, cleanup] of steps) {
    try { await cleanup(); }
    catch (error) { errors.push(error); report(`${label}: ${name} cleanup failed`, error); }
  }
  if (failure) throw failure.error;
  if (errors.length) throw new AggregateError(errors, `${label} cleanup failed`);
}

// Install immediately after spawn: exitCode alone does not mean that stdio and
// the owned process handle have closed. Keep the promise tied to this child,
// including when the caller later starts another executable.
export function trackChildShutdown(child, { graceMs = 5000, killMs = 5000 } = {}) {
  let closed = false, spawnError, stopping;
  const close = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ pid: child.pid, code, signal });
    });
  });
  async function wait(ms) {
    let timer;
    try {
      return await Promise.race([close, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
    } finally { clearTimeout(timer); }
  }
  return function stop() {
    return stopping ??= (async () => {
      if (!closed && child.exitCode === null && child.signalCode === null && !spawnError) child.kill('SIGTERM');
      let result = await wait(graceMs);
      if (!result) {
        // Reap a still-running child, but fail the case even if forced cleanup
        // succeeds. Never hide a shutdown regression behind a passing prefix.
        if (child.exitCode === null && child.signalCode === null && !spawnError) child.kill('SIGKILL');
        result = await wait(killMs);
        const detail = result ? `closed during cleanup (code=${result.code}, signal=${result.signal})`
          : `close still missing after ${killMs} ms cleanup`;
        throw new Error(`Child ${child.pid ?? 'unspawned'} shutdown timed out after ${graceMs} ms; ${detail}`);
      }
      if (spawnError) throw spawnError;
      return result;
    })();
  };
}
