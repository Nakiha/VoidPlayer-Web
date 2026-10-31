import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const codeFile = (file) => /\.(?:[cm]?[jt]sx?|css)$/.test(file) && !/(^|\/)(generated|vendor)\//.test(file);
export async function formatFiles({ root = repositoryRoot, base, write = false, files = [] } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).split('\0').filter(Boolean);
  const managed = JSON.parse(await readFile(path.join(root, 'scripts/testing/format-files.json'), 'utf8'));
  const changed = base ? git(['diff', '--name-only', '--diff-filter=ACMR', '-z', base, 'HEAD']) : [];
  const working = git(['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD']);
  const added = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const selected = [...new Set([...managed, ...changed, ...working, ...added, ...files])].filter(codeFile).sort();
  const config = await prettier.resolveConfig(path.join(root, '.prettierrc.json'));
  const failures = [];
  for (const file of selected) {
    const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep)) throw new Error(`Format path escapes repository: ${file}`);
    let source;
    try {
      source = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const formatted = await prettier.format(source, { ...config, filepath: target });
    if (formatted !== source) {
      failures.push(file);
      if (write) await writeFile(target, formatted);
    }
  }
  return { files: selected.length, failures };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = { files: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') options.write = true;
    else if (args[i] === '--base' && args[i + 1]) options.base = args[++i];
    else if (args[i].startsWith('-')) throw new Error(`Unknown format option: ${args[i]}`);
    else options.files.push(args[i]);
  }
  const result = await formatFiles(options);
  for (const file of result.failures) console.error(`${options.write ? 'Formatted' : 'Needs formatting'}: ${file}`);
  console.log(`Format ${options.write || !result.failures.length ? 'passed' : 'failed'}: ${result.files} files`);
  if (!options.write && result.failures.length) process.exitCode = 1;
}
