import type { QualityExecutionContext } from "../quality/execution-context.ts";
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import {
  XPSNR_CAPABILITY,
  XPSNR_LIMITS,
  XPSNR_FILTER_SHA256,
  XpsnrError,
  canonicalJson,
} from "../../../shared/analysis/quality/xpsnr.ts";
import type {
  XpsnrInput,
  XpsnrPlanSnapshot,
  XpsnrPrepared,
  XpsnrNativeResult,
} from "../../../shared/analysis/quality/xpsnr.ts";
import { AnalysisScoringRunner } from "../quality/analysis-scoring-runner.ts";
import type {AnalysisComponentOwner} from "../quality/component-owner.ts";
import { AdminError } from "../../admin-error.ts";
import type { VmafHooks as XpsnrHooks } from "../vmaf/runner.ts";

/** Uses the existing job lifecycle and physical Worker-exit supervision. The
 * decoding Worker feeds pixels directly into the existing analysis artifact. */
export class WasmXpsnrRunner extends AnalysisScoringRunner {
  constructor(
    library: QualityExecutionContext,
    coreDir: string,
    analysisDir: string,
    components?: AnalysisComponentOwner,
  ) {
    super(library, coreDir, analysisDir, 'xpsnr', components);
  }
  assertAvailable() {
    try {
      this.components.snapshot("xpsnr");
    } catch (error) {
      throw new AdminError(
        503,
        (error as Error).message,
        "component-unavailable",
      );
    }
  }
  async capability() {
    const basic = {
      ...XPSNR_CAPABILITY,
      platforms: ["wasm32"],
      configured: true,
      enabled: false,
      reason: "component-unavailable",
    };
    try {
      const { component: c, version } = await this.components.verify("xpsnr");
      return {
        ...basic,
        enabled: true,
        reason: null,
        component: {
          manifestSha256: c.manifestSha256,
          sourceRevision: c.sourceRevision,
          cliVersion: version,
          executor: c.executor,
        },
      };
    } catch (error) {
      return {
        ...basic,
        reason: (error as { code?: string }).code ?? "component-unavailable",
      };
    }
  }
  private async contract(): Promise<NonNullable<QualityExecutionContract["analysis"]>> {
    return {
      component: (await this.components.verify("xpsnr",true)).component,
      recipe: "xpsnr-pixel-api-clip-v1",
    };
  }
  private data(
    input: XpsnrInput,
    snapshot: XpsnrPlanSnapshot,
    contract: QualityExecutionContract["analysis"],
  ) {
    return {
      metric: "xpsnr",
      database: this.library.indexDatabase,
      coreDir: this.coreDir,
      analysisDir: this.analysisDir,
      input,
      snapshot,
      analysisContract: contract,
    };
  }
  async reexecutionPreflight(
    input: XpsnrInput,
    snapshot: XpsnrPlanSnapshot,
    expected: QualityExecutionContract,
    signal: AbortSignal,
  ) {
    return this.owned(
      { budget: { maxElapsedMs: Math.min(input.budget.maxElapsedMs, 30000) } },
      signal,
      () => {},
      async (combined) =>
        this.worker<{
          contract: QualityExecutionContract;
          indexBytes: number;
          indexPackets: number;
        }>(
          "../xpsnr/decode-worker.ts",
          {
            ...this.data(input, snapshot, await this.contract()),
            mode: "preflight",
            expectedExecutionContract: expected,
          },
          combined,
        ),
    );
  }
  async preflight(
    input: XpsnrInput,
    snapshot: XpsnrPlanSnapshot,
    signal: AbortSignal,
  ) {
    return this.owned(
      input,
      signal,
      () => {},
      async (combined) => {
        const contract = await this.contract();
        const value = await this.worker(
          "../xpsnr/decode-worker.ts",
          { ...this.data(input, snapshot, contract), mode: "preflight" },
          combined,
        );
        return {
          eligibility: value,
          component: {
            manifestSha256: contract.component.manifestSha256,
            filterSha256: XPSNR_FILTER_SHA256,
          },
          rawColorVerification: "required-at-execution",
          nativeExecution: false,
          executor: "analysis-wasm",
        };
      },
    );
  }
  async run(
    input: XpsnrInput,
    snapshot: XpsnrPlanSnapshot,
    signal: AbortSignal,
    hooks: XpsnrHooks,
  ) {
    return this.owned(
      {
        budget: {
          maxElapsedMs: Math.min(
            input.budget.maxElapsedMs,
            input.budget.nativeCpuSeconds * 1000,
          ),
        },
      },
      signal,
      hooks.admitted,
      async (combined) => {
        let executedContract: QualityExecutionContract | undefined;
        const contract = await this.contract(),
          data = this.data(input, snapshot, contract);
        hooks.phase("decode-and-score");
        const value = await this.worker<{
          prepared: XpsnrPrepared;
          native: XpsnrNativeResult;
        }>(
          "../quality/scoring-worker.ts",
          {
            ...data,
            mode: "decode",
            expectedExecutionContract: hooks.expectedExecutionContract,
          },
          combined,
          hooks.progress,
          (contract) => {
            executedContract = contract;
            hooks.contract?.(contract);
          },
        );
        combined.throwIfAborted();
        hooks.prepared(value.prepared);
        hooks.phase("source-final");
        if (canonicalJson(contract) !== canonicalJson(await this.contract()))
          throw new XpsnrError(
            "component-unavailable",
            "Analysis component changed during scoring",
          );
        const verification = await this.worker<{
          indexBytes: number;
          indexPackets: number;
          elapsedMs: number;
        }>(
          "../xpsnr/decode-worker.ts",
          {
            ...data,
            mode: "verify",
            expectedExecutionContract: executedContract,
          },
          combined,
        );
        combined.throwIfAborted();
        if (canonicalJson(contract) !== canonicalJson(await this.contract()))
          throw new XpsnrError(
            "component-unavailable",
            "Analysis component changed during final verification",
          );
        if (
          value.prepared.work.indexBytes + verification.indexBytes >
            XPSNR_LIMITS.maxIndexBytes ||
          value.prepared.work.indexPackets + verification.indexPackets >
            XPSNR_LIMITS.maxIndexPackets
        )
          throw new XpsnrError(
            "budget-exceeded",
            "Final index verification exceeds budget",
          );
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
