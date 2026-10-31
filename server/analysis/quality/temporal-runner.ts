import type { TemporalPrepared, TemporalPlanSnapshot } from '../../../shared/analysis/quality/temporal-contract.ts';
import type { QualityExecutionContext } from './execution-context.ts';
import type { QualityExecutionContract } from '../../../shared/analysis/quality/reexecution.ts';
import { canonicalJson } from '../../../shared/analysis/quality/vmaf.ts';
import type { VmafInput, VmafNativeResult } from '../../../shared/analysis/quality/vmaf.ts';
import type { XpsnrInput, XpsnrNativeResult } from '../../../shared/analysis/quality/xpsnr.ts';
import { AnalysisScoringRunner } from './analysis-scoring-runner.ts';
import type { AnalysisComponentOwner } from './component-owner.ts';

export type TemporalHooks = {
  expectedExecutionContract?: QualityExecutionContract;
  contract?(value: QualityExecutionContract): void;
  admitted(): void;
  phase(name: string): void;
  progress(frames: number, total: number): void;
  prepared(value: TemporalPrepared): void;
};
/** One physical ownership span covers preflight, decode/score, component and
 * source verification. Metric adapters supply identities and errors only. */
export abstract class TemporalScoringRunner<
  I extends VmafInput | XpsnrInput,
  N extends VmafNativeResult | XpsnrNativeResult,
> extends AnalysisScoringRunner {
  private kind: 'vmaf' | 'xpsnr';
  private limits: { maxIndexBytes: number; maxIndexPackets: number };
  constructor(
    library: QualityExecutionContext,
    coreDir: string,
    analysisDir: string,
    kind: 'vmaf' | 'xpsnr',
    limits: { maxIndexBytes: number; maxIndexPackets: number },
    components?: AnalysisComponentOwner,
  ) {
    super(library, coreDir, analysisDir, kind, components);
    this.kind = kind;
    this.limits = limits;
  }
  protected abstract contract(input: I): Promise<NonNullable<QualityExecutionContract['analysis']>>;
  protected abstract componentIdentity(input: I): { modelSha256: string } | { filterSha256: string };
  protected abstract metricError(code: string, message: string): Error;
  protected async describeCapability<T>(capability: T) {
    const basic = { ...capability, platforms: ['wasm32'], configured: true, enabled: false, reason: 'component-unavailable' };
    try {
      const { component: c, version } = await this.components.verify(this.kind);
      return {
        ...basic,
        enabled: true,
        reason: null,
        component: { manifestSha256: c.manifestSha256, sourceRevision: c.sourceRevision, cliVersion: version, executor: c.executor },
      };
    } catch (error) {
      return { ...basic, reason: (error as { code?: string }).code ?? 'component-unavailable' };
    }
  }
  private data(input: I, snapshot: TemporalPlanSnapshot, contract: QualityExecutionContract['analysis']) {
    return {
      metric: this.kind,
      database: this.library.indexDatabase,
      coreDir: this.coreDir,
      analysisDir: this.analysisDir,
      input,
      snapshot,
      analysisContract: contract,
    };
  }
  async reexecutionPreflight(input: I, snapshot: TemporalPlanSnapshot, expected: QualityExecutionContract, signal: AbortSignal) {
    return this.owned(
      { budget: { maxElapsedMs: Math.min(input.budget.maxElapsedMs, 30000) } },
      signal,
      () => {},
      async (combined) =>
        this.worker<{ contract: QualityExecutionContract; indexBytes: number; indexPackets: number }>(
          this.kind === 'vmaf' ? 'decode-worker.ts' : '../xpsnr/decode-worker.ts',
          { ...this.data(input, snapshot, await this.contract(input)), mode: 'preflight', expectedExecutionContract: expected },
          combined,
        ),
    );
  }
  async preflight(input: I, snapshot: TemporalPlanSnapshot, signal: AbortSignal) {
    return this.owned(
      input,
      signal,
      () => {},
      async (combined) => {
        const contract = await this.contract(input);
        const value = await this.worker(
          this.kind === 'vmaf' ? 'decode-worker.ts' : '../xpsnr/decode-worker.ts',
          { ...this.data(input, snapshot, contract), mode: 'preflight' },
          combined,
        );
        return {
          eligibility: value,
          component: { manifestSha256: contract.component.manifestSha256, ...this.componentIdentity(input) },
          rawColorVerification: 'required-at-execution',
          nativeExecution: false,
          executor: 'analysis-wasm',
        };
      },
    );
  }
  async run(input: I, snapshot: TemporalPlanSnapshot, signal: AbortSignal, hooks: TemporalHooks) {
    return this.owned(
      { budget: { maxElapsedMs: Math.min(input.budget.maxElapsedMs, input.budget.nativeCpuSeconds * 1000) } },
      signal,
      hooks.admitted,
      async (combined) => {
        let executedContract: QualityExecutionContract | undefined;
        const contract = await this.contract(input),
          data = this.data(input, snapshot, contract);
        hooks.phase('decode-and-score');
        const value = await this.worker<{ prepared: TemporalPrepared; native: N }>(
          '../quality/scoring-worker.ts',
          { ...data, mode: 'decode', expectedExecutionContract: hooks.expectedExecutionContract },
          combined,
          hooks.progress,
          (contract) => {
            executedContract = contract;
            hooks.contract?.(contract);
          },
        );
        combined.throwIfAborted();
        hooks.prepared(value.prepared);
        hooks.phase('source-final');
        if (canonicalJson(contract) !== canonicalJson(await this.contract(input)))
          throw this.metricError('component-unavailable', 'Analysis component changed during scoring');
        const verification = await this.worker<{ indexBytes: number; indexPackets: number; elapsedMs: number }>(
          this.kind === 'vmaf' ? 'decode-worker.ts' : '../xpsnr/decode-worker.ts',
          { ...data, mode: 'verify', expectedExecutionContract: executedContract },
          combined,
        );
        combined.throwIfAborted();
        if (canonicalJson(contract) !== canonicalJson(await this.contract(input)))
          throw this.metricError('component-unavailable', 'Analysis component changed during final verification');
        if (
          value.prepared.work.indexBytes + verification.indexBytes > this.limits.maxIndexBytes ||
          value.prepared.work.indexPackets + verification.indexPackets > this.limits.maxIndexPackets
        )
          throw this.metricError('budget-exceeded', 'Final index verification exceeds budget');
        value.prepared.work.indexBytes += verification.indexBytes;
        value.prepared.work.indexPackets += verification.indexPackets;
        value.native.resources.finalVerification = {
          indexBytes: verification.indexBytes,
          indexPackets: verification.indexPackets,
          elapsedMs: verification.elapsedMs,
        };
        return value;
      },
    );
  }
}
