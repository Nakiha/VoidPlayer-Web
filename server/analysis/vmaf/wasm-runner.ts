import type { QualityExecutionContext } from '../quality/execution-context.ts';
import type { QualityExecutionContract } from '../../../shared/analysis/quality/reexecution.ts';
import { VMAF_CAPABILITY, VMAF_LIMITS, VMAF_MODELS, VmafError } from '../../../shared/analysis/quality/vmaf.ts';
import type { VmafInput, VmafNativeResult } from '../../../shared/analysis/quality/vmaf.ts';
import { TemporalScoringRunner } from '../quality/temporal-runner.ts';
import type { AnalysisComponentOwner } from '../quality/component-owner.ts';

/** Uses the existing job lifecycle and physical Worker-exit supervision. The
 * decoding Worker feeds pixels directly into the existing analysis artifact. */
export class WasmVmafRunner extends TemporalScoringRunner<VmafInput, VmafNativeResult> {
  constructor(library: QualityExecutionContext, coreDir: string, analysisDir: string, components?: AnalysisComponentOwner) {
    super(library, coreDir, analysisDir, 'vmaf', VMAF_LIMITS, components);
  }
  assertAvailable() {
    this.components.snapshot('vmaf');
  }
  capability() { return this.describeCapability(VMAF_CAPABILITY); }
  protected async contract(input: VmafInput): Promise<NonNullable<QualityExecutionContract['analysis']>> {
    return { component: (await this.components.verify('vmaf', true)).component, model: input.model, recipe: 'libvmaf-pixel-api-clip-v1' };
  }
  protected componentIdentity(input: VmafInput) { return { modelSha256: VMAF_MODELS[input.model].sha256 }; }
  protected metricError(code: string, message: string) { return new VmafError(code, message); }
}
