import assert from 'node:assert/strict';

/** A self-inflicted SIGKILL is reported as a nonzero process exit on Windows,
 * where POSIX signal exit status is unavailable. Call only after close and
 * together with the crash-site marker and persisted transaction assertions. */
export function assertForcedProcessExit(child) {
  if (process.platform === 'win32') {
    assert.equal(child.signalCode, null);
    assert.ok(Number.isInteger(child.exitCode) && child.exitCode !== 0,
      `Expected a forced nonzero Windows exit, got ${child.exitCode}`);
  } else {
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.exitCode, null);
  }
}
