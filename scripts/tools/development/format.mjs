import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const codeFile = file => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/(^|\/)(generated|vendor)\//.test(file);

/** Read-only hygiene, limited to added/modified lines. Layout is deliberately
 * not canonicalized: short declarations, interfaces and methods may stay compact. */
export function checkHygiene(source, lines) {
  const failures = [], text = source.split('\n');
  for (const line of lines) {
    const value = text[line - 1];
    if (value === undefined) continue;
    if (value.endsWith('\r')) failures.push({ line, reason: 'Use LF line endings' });
    if (/^[ \t]*\t/.test(value)) failures.push({ line, reason: 'Use spaces for indentation' });
    if (/[ \t]+\r?$/.test(value)) failures.push({ line, reason: 'Remove trailing whitespace' });
  }
  return failures;
}
export async function checkFiles({ root = repositoryRoot, base = 'HEAD', files = [] } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const revision = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  // Compare the base directly with the working tree so committed, staged and
  // unstaged insertions share the same final line coordinates.
  const changed = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', revision]).split('\0').filter(Boolean);
  const added = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const whole = new Set([...added, ...files]);
  const selected = [...new Set([...changed, ...whole])].filter(codeFile).sort();
  const failures = [];
  let checkedLines = 0;
  for (const file of selected) {
    const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep)) throw new Error(`Check path escapes repository: ${file}`);
    let source;
    try { source = await readFile(target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const lines = new Set();
    if (whole.has(file)) source.split('\n').forEach((_, index) => lines.add(index + 1));
    else {
      const patch = git(['diff', '--no-ext-diff', '--no-color', '--unified=0', revision, '--', file]);
      for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let index = start; index < start + count; index++) lines.add(index);
      }
    }
    checkedLines += lines.size;
    failures.push(...checkHygiene(source, lines).map(failure => ({ file, ...failure })));
  }
  return { files: selected.length, lines: checkedLines, failures };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = { files: [] };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--base' && args[index + 1]) options.base = args[++index];
    else if (args[index].startsWith('-')) throw new Error(`Unknown hygiene option: ${args[index]}`);
    else options.files.push(args[index]);
  }
  const result = await checkFiles(options);
  for (const failure of result.failures) console.error(`${failure.file}:${failure.line}: ${failure.reason}`);
  console.log(`Changed-line hygiene ${result.failures.length ? 'failed' : 'passed'}: ${result.files} files, ${result.lines} lines; no layout rewrite`);
  if (result.failures.length) process.exitCode = 1;
}
