import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import * as prettier from 'prettier';
import { formatFiles, repositoryRoot } from '../../scripts/tools/development/format.mjs';

const config = await prettier.resolveConfig(path.join(repositoryRoot, '.prettierrc.json'));
test('compact declarations fit on one line and execution/resource order stays visible', async () => {
  const source = `import {first,second} from './module.ts';
const journal = new FrozenSubmissionJournal(\n sessionStorage,\n storage,\n cambiInput,\n);
async function execute(){ const lease=acquire(); try {await run(); commit();} finally {await stop(); lease.release();}}
`;
  const formatted = await prettier.format(source, { ...config, parser: 'typescript' });
  assert.ok(formatted.includes("import { first, second } from './module.ts';"));
  assert.ok(formatted.includes('const journal = new FrozenSubmissionJournal(sessionStorage, storage, cambiInput);'));
  assert.match(formatted, /await run\(\);\n\s+commit\(\);/);
  assert.match(formatted, /await stop\(\);\n\s+lease.release\(\);/);
  assert.equal(await prettier.format(formatted, { ...config, parser: 'typescript' }), formatted);
});
test('format gate covers committed changes, working files and new files beyond the initial migration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vp-format-'));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  try {
    await mkdir(path.join(root, 'scripts/testing'), { recursive: true });
    await writeFile(path.join(root, 'scripts/testing/format-files.json'), '[]');
    await writeFile(path.join(root, '.prettierrc.json'), JSON.stringify(config));
    await writeFile(path.join(root, 'legacy.ts'), 'export const untouched=1;');
    await writeFile(path.join(root, 'changed.ts'), 'export const value=1;');
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
    const base = git(['rev-parse', 'HEAD']);
    await writeFile(path.join(root, 'changed.ts'), 'export const value=2;');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'change']);
    await writeFile(path.join(root, 'new.ts'), 'export const added=3;');
    assert.deepEqual((await formatFiles({ root, base })).failures, ['changed.ts', 'new.ts']);
    await formatFiles({ root, base, write: true });
    assert.deepEqual((await formatFiles({ root, base })).failures, []);
    assert.equal(await readFile(path.join(root, 'legacy.ts'), 'utf8'), 'export const untouched=1;');
    await assert.rejects(formatFiles({ root, base: 'missing-base' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
