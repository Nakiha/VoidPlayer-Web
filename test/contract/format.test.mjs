import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { checkFiles, checkHygiene } from '../../scripts/tools/development/format.mjs';

const compact = `import { first, second } from './module.ts';
const journal = new FrozenSubmissionJournal(sessionStorage, storage, cambiInput);
const sx = x + d.visibleRect.x, sy = y + d.visibleRect.y;
const e = clamp(signal), a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
interface Rect { x: number; y: number; width: number; height: number; }
class Source {
  get terminationCallbackErrors(): readonly unknown[] { return this.cleanupCallbackErrors; }
  frameAt(pts: number) { return this.source.frameAt(pts); }
}
if (closed) return;
if (closed) { return; }
async function execute() {
  const lease = acquire();
  try {
    await run();
    commit();
  } finally {
    await stop();
    lease.release();
  }
}
`;
test('compact variable groups, data, getters, forwarding methods and guards are accepted without rewriting', () => {
  assert.deepEqual(checkHygiene(compact, compact.split('\n').map((_, index) => index + 1)), []);
});
test('a small committed/staged/working change never requires migrating untouched file layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-hygiene-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  const file = path.join(root, 'old file.ts');
  try {
    await writeFile(file, '\tconst legacy=1;  \nconst value = 1;\n');
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
    const base = git(['rev-parse', 'HEAD']);
    await writeFile(file, '\tconst legacy=1;  \nconst value = 2;\n');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'small change']);
    await writeFile(file, '// Working-tree insertion\n\tconst legacy=1;  \nconst value = 3;\n');
    git(['add', '.']);
    await writeFile(file, '// Working-tree insertion\n\tconst legacy=1;  \nconst value = 4;\n');
    await writeFile(path.join(root, 'new.ts'), compact);
    assert.deepEqual((await checkFiles({ root, base })).failures, []);
    assert.deepEqual((await checkFiles({ root, base, files: ['old file.ts'] })).failures.map(f => f.line), [2, 2]);
    assert.equal(await readFile(path.join(root, 'new.ts'), 'utf8'), compact);
    await writeFile(path.join(root, 'new.ts'), compact + '\tbad();  \r\n');
    assert.deepEqual((await checkFiles({ root, base })).failures.map(f => f.reason), [
      'Use LF line endings', 'Use spaces for indentation', 'Remove trailing whitespace',
    ]);
    await assert.rejects(checkFiles({ root, base: 'missing-base' }));
    assert.equal(await readFile(file, 'utf8'), '// Working-tree insertion\n\tconst legacy=1;  \nconst value = 4;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
