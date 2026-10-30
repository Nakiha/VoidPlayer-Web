import path from "node:path";
import type { MediaLibraryIndex } from "../../library.ts";
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import {
  CAMBI_CAPABILITY,
  CAMBI_LIMITS,
  CambiError,
  canonicalJson,
} from "../../../shared/analysis/quality/cambi.ts";
import type {
  CambiInput,
  CambiPrepared,
  CambiNative,
} from "../../../shared/analysis/quality/cambi.ts";
import { ScoringWorkerOwner } from "../quality/scoring-worker-owner.ts";
import type { CambiHooks } from "./runner.ts";
import { analysisComponent } from "../quality/analysis-component.ts";
import { AdminError } from "../../admin-error.ts";

export class WasmCambiRunner extends ScoringWorkerOwner {
  readonly analysisDir: string;
  constructor(
    library: MediaLibraryIndex,
    coreDir: string,
    analysisDir: string,
  ) {
    super(library, coreDir);
    this.analysisDir = analysisDir;
  }
  /** Reclaim only legacy interrupted scratch data; new runs never write raw clips. */
  directory(id: string) {
    if (!/^cambi-[a-f0-9-]{36}$/.test(id))
      throw new CambiError("invalid-request", "Invalid historical job ID");
    return path.join(this.library.indexDatabase + ".cambi-tmp", id);
  }
  async inspectCambi(
    input: CambiInput,
    target: import("../../../shared/analysis/quality/frame-pair.ts").PairTarget,
    signal: AbortSignal,
  ) {
    return this.owned(
      input,
      signal,
      () => {},
      (s) =>
        this.worker<{
          frame: import("../../../shared/analysis/quality/psnr.ts").PsnrFrame;
          provenance: import("../../../shared/analysis/quality/frame-pair.ts").PairProvenance;
          decoder: import("../../../shared/analysis/quality/frame-pair.ts").PairDecoder["version"];
          work: unknown;
        }>(
          "../cambi/decode-worker.ts",
          {
            mode: "picture",
            database: this.library.indexDatabase,
            coreDir: this.coreDir,
            input,
            target,
          },
          s,
        ),
    );
  }
  assertAvailable() {
    try {
      analysisComponent(this.analysisDir);
    } catch (error) {
      throw new AdminError(
        503,
        (error as Error).message,
        "component-unavailable",
      );
    }
  }
  async cambiCapability() {
    const basic = {
      ...CAMBI_CAPABILITY,
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
        selfTest: "artifact-hashes-verified; pixel-ABI-checked-at-execution",
      };
    } catch (error) {
      return {
        ...basic,
        reason: (error as { code?: string }).code ?? "component-unavailable",
      };
    }
  }
  private contract(): NonNullable<QualityExecutionContract["analysis"]> {
    return {
      component: analysisComponent(this.analysisDir).component,
      recipe: "libvmaf-cambi-63-memory-heatmaps-v1",
    };
  }
  private data(
    input: CambiInput,
    contract: QualityExecutionContract["analysis"],
  ) {
    return {
      database: this.library.indexDatabase,
      coreDir: this.coreDir,
      analysisDir: this.analysisDir,
      input,
      analysisContract: contract,
    };
  }
  async cambiReexecutionPreflight(
    input: CambiInput,
    expected: QualityExecutionContract,
    signal: AbortSignal,
  ) {
    return this.owned(
      { budget: { maxElapsedMs: Math.min(input.budget.maxElapsedMs, 30000) } },
      signal,
      () => {},
      (combined) =>
        this.worker(
          "../cambi/decode-worker.ts",
          {
            ...this.data(input, this.contract()),
            mode: "preflight",
            expectedExecutionContract: expected,
          },
          combined,
        ),
    );
  }
  async runCambi(
    _id: string,
    input: CambiInput,
    signal: AbortSignal,
    hooks: CambiHooks,
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
        const contract = this.contract(),
          data = this.data(input, contract);
        hooks.phase("decode-and-score");
        const value = await this.worker<{
          prepared: CambiPrepared;
          native: CambiNative;
        }>(
          "../quality/scoring-worker.ts",
          {
            ...data,
            mode: "decode",
            metric: "cambi",
            expectedExecutionContract: hooks.expectedExecutionContract,
          },
          combined,
          hooks.progress,
          (contract) => {
            executedContract = contract;
            hooks.contract?.(contract);
          },
          async (message) => {
            if (!hooks.streamFrame)
              throw new CambiError(
                "execution-failed",
                "Streaming evidence consumer missing",
              );
            combined.throwIfAborted();
            await hooks.streamFrame(
              message.frame,
              message.header,
              message.score,
              message.maps,
            );
          },
        );
        combined.throwIfAborted();
        hooks.prepared(value.prepared);
        hooks.phase("source-final");
        if (canonicalJson(contract) !== canonicalJson(this.contract()))
          throw new CambiError(
            "component-unavailable",
            "Analysis component changed during scoring",
          );
        const verification = await this.worker<{
          indexBytes: number;
          indexPackets: number;
          witness: {
            passes: number;
            assetBytes: number;
            producerBytes: number;
          };
        }>(
          "../cambi/decode-worker.ts",
          {
            ...data,
            mode: "verify",
            expectedExecutionContract: executedContract,
            remainingIndex: {
              maxIndexBytes:
                CAMBI_LIMITS.maxIndexBytes - value.prepared.work.indexBytes,
              maxIndexPackets:
                CAMBI_LIMITS.maxIndexPackets - value.prepared.work.indexPackets,
            },
          },
          combined,
        );
        combined.throwIfAborted();
        if (canonicalJson(contract) !== canonicalJson(this.contract()))
          throw new CambiError(
            "component-unavailable",
            "Analysis component changed during final verification",
          );
        value.prepared.work.indexBytes += verification.indexBytes;
        value.prepared.work.indexPackets += verification.indexPackets;
        if (value.prepared.work.executionWitness) {
          const w = value.prepared.work.executionWitness;
          w.passes += verification.witness.passes;
          w.assetBytes += verification.witness.assetBytes;
          w.producerBytes += verification.witness.producerBytes;
        }
        return value;
      },
    );
  }
}
