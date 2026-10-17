import { parseAnalysisOptions, analysisResponsibilities } from './analysis/plan.mjs';

export function describeTestPlan(selection) {
  const cases = selection.selected.map(row => {
    const owner = row.implementation ?? row.script;
    const command = row.command ?? [];
    let layer = row.layer ?? (owner?.startsWith('test/unit/') ? 'logic' : owner?.startsWith('test/contract/') ? 'contract'
      : owner?.startsWith('test/media/') ? 'media-integration' : row.engines?.some(engine => ['webkit', 'chromium', 'chrome', 'msedge'].includes(engine)) ? 'browser-system' : 'integration');
    let responsibility = row.responsibility ?? null, stages;
    if (owner === 'scripts/testing/browser/media/bitstream-analysis.mjs' && row.kind === 'regression') {
      const options = parseAnalysisOptions(command.slice(command.indexOf(owner) + 1));
      const groups = options.scenarios.map(name => analysisResponsibilities[name]);
      layer = groups.length === 1 ? groups[0].layer : 'media-integration';
      responsibility = groups.map(group => group.purpose).join('; ');
      stages = groups.flatMap(group => group.stages);
    }
    return { id: row.id, owner, layer, responsibility, reviewNeeded: !responsibility, stages,
      engines: row.engines, inputs: row.inputs, fixtures: row.fixtures, tools: row.tools, build: row.build, required: row.required, timeoutMs: row.timeoutMs, command };
  });
  return { cases, summary: { total: cases.length, responsibilityReviewNeeded: cases.filter(row => row.reviewNeeded).length,
    layers: Object.fromEntries([...new Set(cases.map(row => row.layer))].sort().map(layer => [layer, cases.filter(row => row.layer === layer).length])) }, excluded: selection.excluded };
}
