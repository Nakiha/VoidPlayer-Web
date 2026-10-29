import {pinComparison,verifyComparison,verifyComparisonSummaries,verifyComparisonPages} from '../../shared/analysis/quality/xpsnr-comparison.ts';
import type {ComparisonFramePage,ComparisonSummary,ComparisonView,XpsnrComparison} from '../../shared/analysis/quality/xpsnr-comparison.ts';
import type {QualityClient} from './quality-jobs.ts';

/** Read-only, at most four versions and four companion frames per version.
 * No scoring, source preparation, candidate publication or retry command. */
export async function readXpsnrComparison(api:Pick<QualityClient,'request'>,actor:string,ids:string[],signal:AbortSignal,expected?:ComparisonView){
  const comparison=await api.request<XpsnrComparison>(actor,'/api/quality/xpsnr/compare?ids='+encodeURIComponent(ids.join(',')),signal);
  const view=expected??pinComparison(comparison);
  verifyComparison(comparison,view);
  if(comparison.items.length!==ids.length||comparison.items.some((item,index)=>item.id!==ids[index]))throw Error('Comparison selection changed');
  const summaries=await Promise.all(comparison.items.map(item=>api.request<ComparisonSummary>(actor,`/api/quality/xpsnr/jobs/${item.id}/result`,signal)));
  verifyComparisonSummaries(comparison,summaries,actor);
  const pages=await Promise.all(comparison.items.map(item=>api.request<ComparisonFramePage>(actor,`/api/quality/xpsnr/jobs/${item.id}/frames?after=${view.after}&limit=4`,signal)));
  verifyComparisonPages(comparison,summaries,pages,view.after);
  return {comparison,view,summaries,pages};
}
export type LoadedXpsnrComparison=Awaited<ReturnType<typeof readXpsnrComparison>>;
