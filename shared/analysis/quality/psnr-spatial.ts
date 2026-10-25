import { PsnrError, psnrGridPlan, rankPsnrBlocks } from './psnr.ts';
import type { PsnrResult, PsnrStatistics } from './psnr.ts';

function check(value: unknown): asserts value {
  if (!value) throw new PsnrError('invalid-input', 'spatial.evidence');
}
const keys = (value: object, expected: string) => value && Object.keys(value).sort().join(',') === expected;
function statistic(stat: PsnrStatistics, samples: number, peak: number) {
  check(stat && keys(stat, 'mse,psnr,samples,sse') && Number.isSafeInteger(stat.sse) && stat.sse >= 0
    && stat.sse <= samples * peak ** 2 && stat.samples === samples && stat.mse === stat.sse / samples);
  if (stat.sse === 0) check(stat.psnr?.kind === 'positive-infinity' && stat.psnr.db === null);
  else check(stat.psnr?.kind === 'finite' && Number.isFinite(stat.psnr.db)
    && Math.abs(stat.psnr.db - 10 * Math.log10(peak ** 2 / stat.mse)) < 1e-10);
}

/** Imported facts are still untrusted. Validate coverage, statistics and ranking
 * before any viewer can turn these numbers into a spatial assertion. */
export function validatePsnrSpatial(metric: PsnrResult): void {
  const grid = metric.spatial;
  if (grid === undefined) return;
  check(grid && keys(grid, 'blockHeight,blockWidth,blocks,columns,partition,ranking,rows,schema,version,worst')
    && grid.schema === 'voidplayer-psnr-block-grid' && grid.version === 1
    && grid.partition === 'roi-anchored-disjoint-even-grid' && grid.ranking === 'aggregate-mse-desc-row-major-ties');
  const plan = psnrGridPlan(metric.roi, {blockWidth:grid.blockWidth, blockHeight:grid.blockHeight});
  check(grid.columns === plan.columns && grid.rows === plan.rows && Array.isArray(grid.blocks) && grid.blocks.length === plan.blocks.length);
  const sums = {y:0, u:0, v:0};
  for (const [index, expected] of plan.blocks.entries()) {
    const block = grid.blocks[index];
    check(block && keys(block, 'aggregate,index,planes,roi') && block.index === index
      && keys(block.roi, 'height,width,x,y') && Object.entries(expected).every(([k, v]) => block.roi[k as 'x'] === v)
      && keys(block.planes, 'u,v,y'));
    const count = expected.width * expected.height;
    for (const component of ['y','u','v'] as const) {
      const stat = block.planes[component];statistic(stat, count / (component === 'y' ? 1 : 4), metric.peak);
      sums[component] += stat.sse;
    }
    statistic(block.aggregate, count * 3 / 2, metric.peak);
    check(block.aggregate.sse === block.planes.y.sse + block.planes.u.sse + block.planes.v.sse);
  }
  const count = metric.roi.width * metric.roi.height;
  for (const c of ['y','u','v'] as const) {statistic(metric.planes[c], count / (c === 'y' ? 1 : 4), metric.peak);check(sums[c] === metric.planes[c].sse);}
  statistic(metric.aggregate, count * 3 / 2, metric.peak);
  check(metric.aggregate.sse === sums.y + sums.u + sums.v && Array.isArray(grid.worst)
    && JSON.stringify(grid.worst) === JSON.stringify(rankPsnrBlocks(grid.blocks)));
}

/** Selection never infers a new ROI, reads media or mutates the evidence. */
export function psnrBlock(metric: PsnrResult, index: number) {
  validatePsnrSpatial(metric);
  if (!Number.isSafeInteger(index) || index < 0 || !metric.spatial || index >= metric.spatial.blocks.length)
    throw new PsnrError('invalid-input', 'spatial.block');
  return structuredClone(metric.spatial.blocks[index]);
}
