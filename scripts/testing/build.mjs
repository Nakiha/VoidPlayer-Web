import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserRegressions } from '../run-browser-regressions.mjs';

const receiptPath = '.run/test-suites/build-receipt.json';
// Hash actual bytes, including ignored decoder binaries and uncommitted edits.
// This is an explicit within-job receipt, never an implicit cross-run cache.
async function digest(root, names) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(root, relative);
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOTDIR') { hash.update(relative); hash.update(await readFile(absolute)); return; }
      if (error.code === 'ENOENT') { hash.update(`missing:${relative}`); return; }
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Build fingerprint does not follow symlinks: ${relative}/${entry.name}`);
      await visit(path.join(relative, entry.name));
    }
  }
  for (const name of names) await visit(name);
  return hash.digest('hex');
}
export async function buildFingerprint(root) {
  const bytes = await digest(root, ['src', 'locales', 'server', 'scripts', 'test', 'public', 'index.html', 'admin/index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']);
  let revision = 'archive';
  try { revision = execFileSync('git', ['describe', '--always', '--dirty'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch {}
  const configuration = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(VITE_|NODE_ENV$|NODE_OPTIONS$)/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({ bytes, revision, configuration })).digest('hex');
}
export async function prepareBuild({ root, directory, output = process.stdout, signal, prepared = false, command = [process.platform === 'win32' ? 'npm.cmd' : 'npm', 'run', 'build'] }) {
  const fingerprint = await buildFingerprint(root);
  const receipt = path.join(root, receiptPath);
  if (prepared) {
    const previous = JSON.parse(await readFile(receipt, 'utf8'));
    if (JSON.stringify(previous.command) !== JSON.stringify(command) || previous.fingerprint !== fingerprint || previous.platform !== process.platform || previous.node !== process.version || previous.output !== await digest(root, ['dist'])) {
      throw new Error('Prepared build is stale or belongs to another configuration. Run --prepare again.');
    }
    output.write('BUILD reused verified preparation receipt\n');
    return;
  }
  await rm(receipt, { force: true });
  const invocation = process.platform === 'win32' && command[0] === 'npm.cmd' ? ['cmd.exe', '/d', '/s', '/c', 'npm.cmd run build'] : command;
  const result = await runBrowserRegressions([{ name: 'build', command: invocation, timeoutMs: 300000 }], { cwd: root, directory: path.join(directory, 'build'), output, signal });
  if (!result.passed) throw new Error('Build preparation failed; see build/results.json');
  if (fingerprint !== await buildFingerprint(root)) throw new Error('Build inputs changed during preparation');
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify({ command, fingerprint, output: await digest(root, ['dist']), platform: process.platform, node: process.version, preparedAt: new Date().toISOString() }, null, 2) + '\n');
}
