import assert from 'node:assert/strict';
import { chmod, lstat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const posixTarget = target => /^bun-(linux|darwin)-/.test(target);

/** Release payloads must be readable/traversable by the deploying account,
 * independent of the compiler's output mode and the builder's umask. */
export async function normalizeReleasePermissions(directory, target, executable) {
  if (!posixTarget(target)) return;
  async function walk(folder) {
    await chmod(folder, 0o755);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert.ok(entry.isFile(), `Release payload must contain ordinary files: ${file}`);
        await chmod(file, file === path.join(directory, executable) ? 0o755 : 0o644);
      }
    }
  }
  await walk(directory);
  await verifyReleaseExecutablePermissions(path.join(directory, executable), target);
}

export async function verifyReleaseExecutablePermissions(file, target) {
  if (!posixTarget(target)) return;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Release executable must be an ordinary file');
  assert.equal(info.mode & 0o7777, 0o755, 'Release executable must have mode 0755; deployment must not require chmod');
}

/** Inspect the shipped archive rather than repairing a test extraction. GNU tar
 * and bsdtar expose the stored POSIX mode in their verbose member listing. */
export function verifyReleaseArchivePermissions(archive, directoryName, target, executable) {
  if (!posixTarget(target)) return;
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  const member = `${directoryName}/${executable}`;
  const lines = execFileSync(tar, ['-tvzf', archive, member], { encoding: 'utf8', maxBuffer: 1024 ** 2 }).trim().split('\n');
  assert.equal(lines.length, 1, 'Release archive must contain exactly one executable member');
  assert.equal(lines[0].slice(0, 10), '-rwxr-xr-x', 'Release archive executable must retain mode 0755');
}
