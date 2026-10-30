import type { QualityExecutionContext } from "../quality/execution-context.ts";
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import {
  VMAF_CAPABILITY,
  VMAF_LIMITS,
  VMAF_MODELS,
  VmafError,
  canonicalJson,
} from "../../../shared/analysis/quality/vmaf.ts";
import type {
  VmafInput,
  VmafPlanSnapshot,
  VmafPrepared,
  VmafNativeResult,
} from "../../../shared/analysis/quality/vmaf.ts";
import { ScoringWorkerOwner } from "../quality/scoring-worker-owner.ts";
import type { VmafHooks } from "./runner.ts";
import { analysisComponent } from "../quality/analysis-component.ts";

/** Uses the existing job lifecycle and physical Worker-exit supervision. The
 * decoding Worker feeds pixels directly into the existing analysis artifact. */
export class WasmVmafRunner extends ScoringWorkerOwner {
  readonly analysisDir: string;
  constructor(
    library: QualityExecutionContext,
    coreDir: string,
    analysisDir: string,
  ) {
    super(library, coreDir, 'vmaf');
    this.analysisDir = analysisDir;
  }
  assertAvailable() {
    analysisComponent(this.analysisDir);
  }
  async capability() {
    const basic = {
      ...VMAF_CAPABILITY,
      platforms: ["wasm32"],
      configured: true,
      enabled: false,
      reason: "component-unavailable",
    };
    try {
      const { component: c, version } = analysisComponent(this.analysisDir);
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
  private contract(
    input: VmafInput,
  ): NonNullable<QualityExecutionContract["analysis"]> {
    return {
      component: analysisComponent(this.analysisDir).component,
      model: input.model,
      recipe: "libvmaf-pixel-api-clip-v1",
    };
  }
  private data(
    input: VmafInput,
    snapshot: VmafPlanSnapshot,
    contract: QualityExecutionContract["analysis"],
  ) {
    return {
      database: this.library.indexDatabase,
      coreDir: this.coreDir,
      analysisDir: this.analysisDir,
      input,
      snapshot,
      analysisContract: contract,
    };
  }
  async reexecutionPreflight(
    input: VmafInput,
    snapshot: VmafPlanSnapshot,
    expected: QualityExecutionContract,
    signal: AbortSignal,
  ) {
    return this.owned(
      { budget: { maxElapsedMs: Math.min(input.budget.maxElapsedMs, 30000) } },
      signal,
      () => {},
      (combined) =>
        this.worker<{
          contract: QualityExecutionContract;
          indexBytes: number;
          indexPackets: number;
        }>(
          "decode-worker.ts",
          {
            ...this.data(input, snapshot, this.contract(input)),
            mode: "preflight",
            expectedExecutionContract: expected,
          },
          combined,
        ),
    );
  }
  async preflight(
    input: VmafInput,
    snapshot: VmafPlanSnapshot,
    signal: AbortSignal,
  ) {
    return this.owned(
      input,
      signal,
      () => {},
      async (combined) => {
        const contract = this.contract(input);
        const value = await this.worker(
          "decode-worker.ts",
          { ...this.data(input, snapshot, contract), mode: "preflight" },
          combined,
        );
        return {
          eligibility: value,
          component: {
            manifestSha256: contract.component.manifestSha256,
            modelSha256: VMAF_MODELS[input.model].sha256,
          },
          rawColorVerification: "required-at-execution",
          nativeExecution: false,
          executor: "analysis-wasm",
        };
      },
    );
  }
  async run(
    input: VmafInput,
    snapshot: VmafPlanSnapshot,
    signal: AbortSignal,
    hooks: VmafHooks,
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
        const contract = this.contract(input),
          data = this.data(input, snapshot, contract);
        hooks.phase("decode-and-score");
        const value = await this.worker<{
          prepared: VmafPrepared;
          native: VmafNativeResult;
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
        if (canonicalJson(contract) !== canonicalJson(this.contract(input)))
          throw new VmafError(
            "component-unavailable",
            "Analysis component changed during scoring",
          );
        const verification = await this.worker<{
          indexBytes: number;
          indexPackets: number;
          elapsedMs: number;
        }>(
          "decode-worker.ts",
          {
            ...data,
            mode: "verify",
            expectedExecutionContract: executedContract,
          },
          combined,
        );
        combined.throwIfAborted();
        if (canonicalJson(contract) !== canonicalJson(this.contract(input)))
          throw new VmafError(
            "component-unavailable",
            "Analysis component changed during final verification",
          );
        if (
          value.prepared.work.indexBytes + verification.indexBytes >
            VMAF_LIMITS.maxIndexBytes ||
          value.prepared.work.indexPackets + verification.indexPackets >
            VMAF_LIMITS.maxIndexPackets
        )
          throw new VmafError(
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
