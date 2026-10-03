import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const repositoryRoot = path.resolve(import.meta.dirname, '../..');
export const testManifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const engines = new Set(['node', 'bun', 'chromium', 'webkit', 'chrome', 'msedge']);
const kinds = new Set(['regression', 'helper', 'diagnostic', 'performance', 'manual-regression']);

export function validateManifest(manifest = testManifest, root = repositoryRoot) {
  const failures = [], ids = new Set(), registered = new Set();
  const fail = message => failures.push(message);
  if (new Set(manifest.suites).size !== manifest.suites.length) fail('Duplicate suite');
  for (const row of manifest.cases) {
    if (!/^(scripts|test)\//.test(row.script) || row.script.split('/').includes('..')) fail(`${row.id}: unsafe script path`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.id) || ids.has(row.id)) fail(`Invalid or duplicate ID: ${row.id}`);
    ids.add(row.id); registered.add(row.script);
    if (!existsSync(path.join(root, row.script))) fail(`Dangling script: ${row.script}`);
    if (row.implementation !== undefined) {
      if (typeof row.implementation !== 'string' || !row.implementation.startsWith('scripts/testing/browser/') || row.implementation.split('/').includes('..')) {
        fail(`${row.id}: unsafe implementation path`);
      } else {
        registered.add(row.implementation);
        if (!existsSync(path.join(root, row.implementation))) fail(`Dangling implementation: ${row.implementation}`);
      }
    }
    if (typeof row.required !== 'boolean') fail(`${row.id}: missing required flag`);
    if (!kinds.has(row.kind)) fail(`${row.id}: unknown kind`);
    if (row.kind !== 'regression' && (!row.restrictions?.length || row.required)) fail(`${row.id}: tool exception needs a reason and required=false`);
    for (const suite of row.suites) if (!manifest.suites.includes(suite)) fail(`${row.id}: unknown suite ${suite}`);
    for (const engine of row.engines) if (!engines.has(engine)) fail(`${row.id}: unknown engine ${engine}`);
    if (!row.platforms.length || row.platforms.some(p => !['linux', 'darwin', 'win32'].includes(p))) fail(`${row.id}: invalid platforms`);
    if (!row.inputs.length || !row.artifacts.length || !(row.timeoutMs > 0) || typeof row.build !== 'boolean') fail(`${row.id}: missing execution metadata`);
    if (!Array.isArray(row.command) || row.command.length < 2 || !row.command.includes(row.script) && !row.command.includes('./' + row.script)) fail(`${row.id}: command does not execute its script`);
    for (const fixture of row.fixtures) if (!manifest.fixtures[fixture]) fail(`${row.id}: unknown fixture ${fixture}`);
    if (row.suites.includes('fast') && (row.fixtures.length || row.tools.length || row.build || row.engines.join() !== 'node')) fail(`${row.id}: fast requires source-only Node checks`);
  }
  function inspect(directory, category) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { inspect(relative, category); continue; }
      const candidate = category === 'test' ? /\.test\.(ts|mjs)$/.test(entry.name)
        : /^(check-|bench-|repro-|diagnose-|test-|compare-index).*\.(mjs|ts|py)$/.test(entry.name)
          || relative.startsWith('scripts/testing/browser/') && /\.mjs$/.test(entry.name);
      if (candidate && !registered.has(relative)) fail(`Unregistered check: ${relative}`);
    }
  }
  for (const category of ['test', 'scripts']) inspect(category, category);
  if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), failures.join('\n'));
  return true;
}

export function selectCases({ suite, caseIds = [], engine, input, platform = process.platform } = {}, manifest = testManifest) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  if (suite && !manifest.suites.includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  if (engine && !engines.has(engine)) throw new Error(`Unknown engine: ${engine}`);
  for (const id of caseIds) if (!manifest.cases.some(row => row.id === id && row.kind === 'regression')) throw new Error(`Unknown runnable case: ${id}`);
  if (!suite && !caseIds.length) throw new Error('Select a suite or --case ID');
  const selected = [], excluded = [];
  for (const row of manifest.cases) {
    if (row.kind !== 'regression' || suite && !row.suites.includes(suite) || caseIds.length && !caseIds.includes(row.id)) continue;
    const reason = !row.platforms.includes(platform) ? `platform ${platform} outside ${row.platforms.join('/')}`
      : engine && !row.engines.includes(engine) ? `engine ${engine} outside ${row.engines.join('/')}`
      : input && !row.inputs.includes(input) ? `input ${input} outside ${row.inputs.join('/')}` : null;
    if (reason) excluded.push({ id: row.id, reason }); else selected.push(row);
  }
  return { selected, excluded };
}

export function browserEntries(suite) {
  return testManifest.cases.filter(row => row.suites.includes(suite)).sort((a, b) => (a.legacyOrder ?? (a.engines[0] === 'chromium' ? 0 : 1)) - (b.legacyOrder ?? (b.engines[0] === 'chromium' ? 0 : 1)))
    .map(row => ({ ...row, name: `${path.basename(row.script, '.mjs')}-${row.engines[0]}`, args: row.command.slice(1) }));
}
