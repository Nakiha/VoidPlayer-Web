import { access } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserRegressions } from '../run-browser-regressions.mjs';

// Only explicitly opted-in, local derived fixtures may be generated here.
// Downloading base media/core artifacts remains the caller's responsibility.
export function createFixturePrerequisites({ fixtures, root, directory, output, signal }) {
  const checked = new Map();
  async function missing(paths) {
    for (const file of paths) {
      try { await access(path.join(root, file)); }
      catch { return file; }
    }
  }
  async function prepare(name) {
    const fixture = fixtures[name];
    let file = await missing(fixture.paths);
    if (!file) return;
    if (fixture.prepareOnDemand) {
      const input = await missing(fixture.inputs);
      if (input) throw new Error(`Missing input for fixture ${name}: ${input}; prepare base fixtures first`);
      const target = path.join(directory, 'fixtures', name);
      const report = await runBrowserRegressions([{ name: `prepare-${name}`, command: fixture.prepare, timeoutMs: 300000 }],
        { cwd: root, directory: target, output, signal });
      if (!report.passed) throw new Error(`Fixture ${name} preparation failed; see ${path.join(target, 'results.json')}`);
      file = await missing(fixture.paths);
      if (!file) return;
    }
    throw new Error(`Missing fixture ${name}: ${file}; prepare with ${fixture.prepare?.join(' ') ?? 'the release workflow'}`);
  }
  return name => {
    // Cache failures too: later independent cases still run, but a broken
    // generator must not be re-run for every dependent case.
    if (!checked.has(name)) checked.set(name, prepare(name));
    return checked.get(name);
  };
}
