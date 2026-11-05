import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cell = value => String(value).replace(/[\r\n|]/g, ' ');
const seconds = ms => (ms / 1000).toFixed(2);

// Costs describe this run; they never change selection, deadlines or pass/fail.
export async function writeExecutionSummary(report, directory, summaryPath) {
  const stages = [];
  for (const row of report.results) {
    const owned = path.join(directory, row.name);
    const files = await readdir(owned).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files.filter(name => /^timings-.*\.json$/.test(name))) {
      const timing = JSON.parse(await readFile(path.join(owned, file), 'utf8'));
      // A reused report directory can contain evidence from a previous run.
      if (!(Date.parse(timing.startedAt) >= Date.parse(row.startedAt))) continue;
      for (const phase of timing.phases) if (Number.isFinite(phase.durationMs)) {
        stages.push({ case: row.id ?? row.name, name: phase.name, status: phase.status, durationMs: phase.durationMs });
      }
    }
  }
  const rows = [...report.results].sort((a, b) => b.durationMs - a.durationMs);
  const lines = [`### ${cell(path.basename(directory))}`, '',
    `${report.passed ? 'Passed' : 'Failed'}; ${report.results.length}/${report.expectedCount} results. ` +
    `Wall ${seconds(report.durationMs)} s; build ${seconds(report.buildDurationMs)} s; ` +
    `case preparation ${seconds(rows.reduce((sum, row) => sum + row.preparationMs, 0))} s; workers ${report.concurrency ?? 1}.`, '',
    '| Case | Status | Preparation (s) | Execution (s) |', '| --- | --- | ---: | ---: |',
    ...rows.slice(0, 10).map(row => `| ${cell(row.id ?? row.name)} | ${row.status} | ${seconds(row.preparationMs)} | ${seconds(row.durationMs)} |`),
  ];
  if (stages.length) lines.push('', 'Longest observed stages (nested stages can overlap):', '',
    '| Case | Stage | Status | Seconds |', '| --- | --- | --- | ---: |',
    ...stages.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
      .map(row => `| ${cell(row.case)} | ${cell(row.name)} | ${row.status} | ${seconds(row.durationMs)} |`));
  const markdown = lines.join('\n') + '\n';
  await writeFile(path.join(directory, 'summary.md'), markdown);
  if (summaryPath) await appendFile(summaryPath, markdown + '\n');
}
