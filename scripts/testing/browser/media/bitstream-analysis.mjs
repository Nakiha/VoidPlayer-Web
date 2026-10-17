import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { repositoryRoot } from '../../manifest.mjs';
import { selectAnalysisMatrixRows } from '../../analysis-matrix.mjs';
import { parseAnalysisOptions, analysisResponsibilities } from '../../analysis/plan.mjs';
import { withAnalysisFixture } from '../../analysis/fixture.mjs';
import { runAnalysisGroups } from '../../analysis/run.mjs';

const options = parseAnalysisOptions(process.argv.slice(2));
// The legacy full entry runs the same three groups with fresh lifecycles.
// A matrix failure must not prevent the independent diagram/index groups.
const controller = new AbortController();
const interrupts = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => [name, () => controller.abort(new Error(`Analysis cancelled by ${name}`))]);
for (const [name, handler] of interrupts) process.on(name, handler);
try {
  await runAnalysisGroups(options.scenarios, async scenario => {
    const matrix = scenario === 'matrix' ? JSON.parse(await readFile(`${repositoryRoot}/scripts/bitstream-analysis-matrix.json`, 'utf8')) : null;
    const matrixRows = matrix ? selectAnalysisMatrixRows(matrix.rows, options.flags).filter(row => !options.matrixFixture || row.fixture === options.matrixFixture) : [];
    if (matrix) assert.ok(matrixRows.length, 'Matrix filter matches a fixture');
    await withAnalysisFixture({ ...options, scenario, matrixRows, signal: controller.signal }, async context => {
      const { page, artifact, errors, rows, engine } = context;
      let limitations = [];
      for (const stage of analysisResponsibilities[scenario].stages) {
        const { run } = await import(`../../analysis/scenarios/${stage}.mjs`);
        const result = await context.stage(`analysis-${stage}`, () => run(context), { scenario });
        if (stage === 'limitations') limitations = result;
      }
      assert.deepEqual(errors, []);
      if (scenario === 'diagrams') {
        assert.equal(rows.filter(row => row.kind === 'whole-stream').length, 2, 'both local and library stream lifecycles are checked');
        assert.equal(limitations.length, options.checkpointOnly ? 2 : 4, 'declared inputs and bit-depth limitation cases are checked');
      }
      if (scenario === 'index') assert.equal(rows.filter(row => row.kind === 'incremental-index').length, 2, 'both continuation and cancellation are checked');
      await writeFile(artifact('matrix.json'), JSON.stringify({ engine, scenario, rows, limitations, errors }, null, 2));
      await page.screenshot({ path: artifact('final.png') });
      console.log(`PASS ${engine}/${scenario}: ${analysisResponsibilities[scenario].purpose}`);
    });
  }, { signal: controller.signal, report: (scenario, error) => console.error(`FAIL ${options.engine}/${scenario}`, error) });
} finally {
  for (const [name, handler] of interrupts) process.off(name, handler);
}
