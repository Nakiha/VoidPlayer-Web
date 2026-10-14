import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryRoot, testManifest, validateManifest, selectCases } from './testing/manifest.mjs';
import { parseOptions } from './testing/options.mjs';
export { parseOptions } from './testing/options.mjs';
import { prepareBuild } from './testing/build.mjs';
import { createFixturePrerequisites } from './testing/fixtures.mjs';
import { runBrowserRegressions } from './run-browser-regressions.mjs';

export async function runTestSuite(selection, { root = repositoryRoot, directory, prepared = false, output = process.stdout, signal, build = prepareBuild, fixtures = testManifest.fixtures } = {}) {
  if (!selection.selected.length) throw new Error('No applicable cases selected; inspect --list and exclusions');
  directory = path.resolve(directory ?? path.join(root, '.run/test-suites/selected'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'selection.json'), JSON.stringify(selection, null, 2) + '\n');
  let buildFailure;
  if (selection.selected.some(row => row.build)) {
    try { await build({ root, directory, prepared, output, signal }); }
    catch (error) { buildFailure = error; }
  }
  const checkedTools = new Map();
  const checkFixture = createFixturePrerequisites({ fixtures, root, directory, output, signal });
  return runBrowserRegressions(selection.selected.map(row => ({ ...row, name: row.id })), {
    cwd: root, directory, signal, output,
    beforeCase: async row => {
      if (row.build && buildFailure) throw buildFailure;
      if (row.restrictions.some(reason => reason.includes('Disposable CI') || reason.includes('disposable CI')) && process.env.CI !== 'true') {
        throw new Error(`${row.id} requires a disposable CI host; certificate trust must not be changed by an ordinary local suite`);
      }
      for (const tool of row.tools) {
        const executable = tool === 'ffmpeg' ? process.env.VOIDPLAYER_FFMPEG_ORACLE ?? tool : tool;
        if (!checkedTools.has(executable)) {
          const result = spawnSync(executable, ['-version'], { stdio: 'ignore', timeout: 5000 });
          checkedTools.set(executable, !result.error);
        }
        if (!checkedTools.get(executable)) throw new Error(`Missing external tool: ${executable}`);
      }
      for (const fixture of row.fixtures) await checkFixture(fixture);
    },
  });
}

export function suiteExitCode(report) {
  const informationalOnly = report.results.length > 0 && report.results.every(row => row.required === false);
  return !report.passed || informationalOnly && report.results.some(row => row.status !== 'passed') ? 1 : 0;
}


if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseOptions(process.argv.slice(2));
  validateManifest();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Suite interrupted'));
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    if (options.check) console.log(`Manifest valid: ${testManifest.cases.length} registered checks`);
    else if (options.prepare) await prepareBuild({ root: repositoryRoot, directory: path.join(repositoryRoot, '.run/test-suites/preparation'), signal: controller.signal });
    else {
      const selection = selectCases(options);
      if (options.list) console.log(JSON.stringify(selection, null, 2));
      else {
        const report = await runTestSuite(selection, { ...options, signal: controller.signal, directory: options.directory ?? path.join(repositoryRoot, '.run/test-suites', options.alias?.replaceAll(':', '-') ?? options.suite ?? 'selected') });
        console.log(`Required checks ${report.passed ? 'passed' : 'failed'}; ${report.results.filter(row => row.status === 'passed').length}/${report.expectedCount} cases passed`);
        for (const row of report.results.filter(row => row.status !== 'passed')) console.error(`${row.required === false ? 'INFO' : 'FAIL'} ${row.id}: ${row.error ?? `exit ${row.exitCode}`} (${row.logPath})`);
        process.exitCode = controller.signal.aborted ? 1 : suiteExitCode(report);
      }
    }
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
