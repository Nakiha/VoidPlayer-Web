import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, utimes, symlink, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('cleanup defaults to dry-run and protects tracked files, user data and documented evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-clean-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vp-clean-outside-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const clean = (...args) => execFileSync(process.execPath, ['scripts/clean.mjs', ...args], { cwd: root, encoding: 'utf8' });
  try {
    await mkdir(path.join(root, 'scripts'));
    await copyFile(new URL('../../scripts/clean.mjs', import.meta.url), path.join(root, 'scripts/clean.mjs'));
    await writeFile(path.join(root, '.gitignore'), '.run/\nartifacts/\n');
    git('init', '--quiet');
    const fixtures = ['.run/stale/frame.bin', '.run/tracked/source.ts', '.run/data/workspaces.sqlite', '.run/evidence/report.json', '.run/recent/frame.bin', 'artifacts/latest-release.json', 'artifacts/voidplayer-old.tar.gz'];
    for (const file of fixtures) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), 'keep bytes');
    }
    await writeFile(path.join(root, 'report.md'), 'Evidence: [.run/evidence/report.json](.run/evidence/report.json)');
    git('add', 'report.md', '.gitignore');
    git('add', '--force', '.run/tracked/source.ts');
    await writeFile(path.join(root, '.run/tracked/source.ts'), 'uncommitted change');
    await writeFile(path.join(outside, 'user.txt'), 'outside bytes');
    await symlink(outside, path.join(root, '.run/external'), process.platform === 'win32' ? 'junction' : 'dir');
    const old = new Date(Date.now() - 30 * 86400_000);
    for (const file of ['.run/stale/frame.bin', '.run/stale', 'artifacts/voidplayer-old.tar.gz']) await utimes(path.join(root, file), old, old);
    // The parent alone looks old; its fresh child must keep the directory alive.
    await utimes(path.join(root, '.run/recent'), old, old);
    assert.match(clean('--keep-days=14'), /未做任何修改/);
    await access(path.join(root, '.run/stale/frame.bin'));
    assert.match(clean('--apply', '--keep-days=14'), /已删除 2 项/);
    await assert.rejects(access(path.join(root, '.run/stale')));
    await access(path.join(root, '.run/recent/frame.bin'));
    clean('--apply', '--keep-days=0');
    for (const file of ['.run/data/workspaces.sqlite', '.run/evidence/report.json', 'artifacts/latest-release.json']) assert.equal(await readFile(path.join(root, file), 'utf8'), 'keep bytes');
    assert.equal(await readFile(path.join(root, '.run/tracked/source.ts'), 'utf8'), 'uncommitted change');
    assert.equal(await readFile(path.join(outside, 'user.txt'), 'utf8'), 'outside bytes');
    assert.throws(() => clean('--only=unknown'), /未知分类/);
    assert.throws(() => clean('--keep-days=-1'), /非负数字/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
