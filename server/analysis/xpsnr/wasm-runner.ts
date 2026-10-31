import type { QualityExecutionContext } from '../quality/execution-context.ts';
import type { QualityExecutionContract } from '../../../shared/analysis/quality/reexecution.ts';
import { XPSNR_CAPABILITY, XPSNR_LIMITS, XPSNR_FILTER_SHA256, XpsnrError } from '../../../shared/analysis/quality/xpsnr.ts';
import type { XpsnrInput, XpsnrNativeResult } from '../../../shared/analysis/quality/xpsnr.ts';
import { TemporalScoringRunner } from '../quality/temporal-runner.ts';
import type { AnalysisComponentOwner } from '../quality/component-owner.ts';
import { AdminError } from '../../admin-error.ts';

/** Uses the existing job lifecycle and physical Worker-exit supervision. The
 * decoding Worker feeds pixels directly into the existing analysis artifact. */
export class WasmXpsnrRunner extends TemporalScoringRunner<XpsnrInput, XpsnrNativeResult> {
  constructor(library: QualityExecutionContext, coreDir: string, analysisDir: string, components?: AnalysisComponentOwner) {
    super(library, coreDir, analysisDir, 'xpsnr', XPSNR_LIMITS, components);
  }
  assertAvailable() {
    try {
      this.components.snapshot('xpsnr');
    } catch (error) {
      throw new AdminError(503, (error as Error).message, 'component-unavailable');
    }
  }
  capability() {
    return this.describeCapability(XPSNR_CAPABILITY);
  }
  protected async contract(): Promise<NonNullable<QualityExecutionContract['analysis']>> {
    return { component: (await this.components.verify('xpsnr', true)).component, recipe: 'xpsnr-pixel-api-clip-v1' };
  }
  protected componentIdentity(input: XpsnrInput) {
    return { filterSha256: XPSNR_FILTER_SHA256 };
  }
  protected metricError(code: string, message: string) {
    return new XpsnrError(code, message);
  }
}
