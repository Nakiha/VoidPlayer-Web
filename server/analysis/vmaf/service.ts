import { temporalWitness, type TemporalPlanSnapshot, type TemporalPrepared } from '../../../shared/analysis/quality/temporal-contract.ts';
import {
  TemporalScoringService,
  scoringDigest as digest,
  scoringNow as now,
} from "../quality/temporal-service.ts";
import { candidatePublication, publishCandidates } from '../quality/candidate-publication.ts';
import type { CandidatePolicy } from '../quality/candidate-publication.ts';
import { validatePreparedFacts } from '../quality/prepared-facts.ts';
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { AdminError } from "../../admin-error.ts";
import type { Actor } from "../../identity.ts";
import type { CorrespondenceService } from "../quality/correspondence-service.ts";
import { qualityEvidenceValue } from "../../../shared/review/quality-evidence.ts";
import type { QualityEvidenceRef } from "../../../shared/review/quality-evidence.ts";
import type { QualityJobResult } from "../../../shared/analysis/quality/jobs.ts";
import type { AnnotationStore } from "../../annotations.ts";
import {
  vmafInput,
  canonicalJson,
  VMAF_LIMITS,
  terminalVmaf,
  VmafError,
} from "../../../shared/analysis/quality/vmaf.ts";
import type { VmafInput, VmafJob, VmafResult, VmafAssociation } from "../../../shared/analysis/quality/vmaf.ts";
import type { WasmVmafRunner } from "./wasm-runner.ts";
export class NativeVmafService extends TemporalScoringService<
  "vmaf",
  VmafInput
> {
  constructor(
    file: string,
    runner: WasmVmafRunner,
    plans: CorrespondenceService,
  ) {
    super(file, runner, plans, "vmaf", VMAF_LIMITS);
    this.runner = runner;
  }
  protected metricError(code: string, message: string) {
    return new VmafError(code, message);
  }
  private runner: WasmVmafRunner;
  protected parse(value: unknown) {
    try {
      return vmafInput(value);
    } catch (error) {
      throw new AdminError(
        400,
        (error as Error).message,
        "invalid-vmaf-request",
      );
    }
  }
  private cachedCapability: Awaited<
    ReturnType<WasmVmafRunner["capability"]>
  > | null = null;
  private capabilityCheckedAt = 0;
  get descriptor() {
    return this.cachedCapability
      ? { ...this.cachedCapability, checkedAt: this.capabilityCheckedAt }
      : null;
  }
  async capability() {
    const value = await this.runner.capability();
    if (value.reason === "quality-busy" && this.cachedCapability)
      return { ...this.descriptor!, verification: "deferred-admission-busy" };
    this.cachedCapability = value;
    this.capabilityCheckedAt = now();
    return { ...this.descriptor!, verification: "checked" };
  }
  async preflight(value: unknown, actor: string, signal: AbortSignal) {
    this.available();
    const input = this.parse(value);
    return this.runner.preflight(input, this.snapshot(input, actor), signal);
  }
  async reexecutionPreflight(
    id: string,
    actor: string,
    expected: QualityExecutionContract,
    signal: AbortSignal,
  ) {
    await this.ready;
    this.available();
    const job = this.get(id, actor);
    const stored = this.frozenSnapshot(id, actor);
    const current = this.snapshot(job.input, actor);
    if (canonicalJson(stored) !== canonicalJson(current))
      throw new AdminError(
        409,
        "Frozen C plan changed; use a new intent.",
        "vmaf-plan-changed",
      );
    return this.runner.reexecutionPreflight(
      job.input,
      stored,
      expected,
      signal,
    );
  }
  protected validatePrepared(
    value: TemporalPrepared,
    snapshot: TemporalPlanSnapshot,
    input: VmafInput) {
    if (
      !value ||
      value.pairs.length < 2 ||
      value.pairs.length > VMAF_LIMITS.frames ||
      canonicalJson(value.sequence.pairs) !==
        canonicalJson(
          [...snapshot.value.rangePlan!.input.pairs].sort(
            (a, b) => a.reference.sourcePtsUs - b.reference.sourcePtsUs,
          ),
        ) ||
      value.sequence.cadenceUs !== input.cadenceUs ||
      canonicalJson(value.sequence.cadence) !== canonicalJson(input.cadence)
    )
      throw new VmafError(
        "worker-result-invalid",
        "Prepared sequence identity changed",
      );
    if (
      value.geometry.width < VMAF_LIMITS.minDimension ||
      value.geometry.height < VMAF_LIMITS.minDimension ||
      value.geometry.width > VMAF_LIMITS.width ||
      value.geometry.height > VMAF_LIMITS.height ||
      ![8, 10].includes(value.geometry.bitDepth)
    )
      throw new VmafError(
        "worker-result-invalid",
        "Prepared raw frame count/geometry differs",
      );
    validatePreparedFacts(value, snapshot, input, VMAF_LIMITS.resultBytes, this.metricError);
  }
  summary(id: string, actor: string) {
    const j = this.get(id, actor),
      r = this.result(id, actor);
    return {
      job: j,
      plan: r.plan,
      geometry: r.prepared.geometry,
      sequence: {
        ...r.prepared.sequence,
        pairs: undefined,
        clockPairs: r.prepared.sequence.pairs.map((p) => ({
          referenceAu: p.reference.picture.au,
          distortedAu: p.distorted.picture.au,
          referencePtsUs: p.reference.sourcePtsUs,
          distortedPtsUs: p.distorted.sourcePtsUs,
          offsetUs: p.distorted.sourcePtsUs - p.reference.sourcePtsUs,
        })),
      },
      coverage: {
        scope: "selected-continuous-clip-not-whole-file",
        targetFrames: r.prepared.pairs.length,
        preparedFrames: r.prepared.pairs.length,
        vmafScoredFrames: r.vmaf?.frames.length ?? 0,
        vmaf: r.vmaf ? "complete-selected-clip" : "unscored",
      },
      raw: r.prepared.raw,
      work: r.prepared.work,
      metrics: r.metrics,
      vmaf: r.vmaf,
      companionPairs: r.prepared.pairs.length,
      framesUrl: `/api/quality/vmaf/jobs/${id}/frames`,
    };
  }
  frames(
    id: string,
    actor: string,
    after = 0,
    limit: number = VMAF_LIMITS.page,
  ) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > VMAF_LIMITS.page
    )
      throw new AdminError(400, "Invalid VMAF frame page.", "invalid-cursor");
    const r = this.result(id, actor),
      indices = r.prepared.pairs.map((_, i) => i).filter((i) => i >= after);
    return {
      entries: indices.slice(0, limit).map((index) => ({
        index,
        score: r.vmaf?.frames[index]?.score ?? null,
        pair: r.prepared.pairs[index],
        ref: this.ref(id, actor, index, "reference"),
      })),
      next: indices.length > limit ? indices[limit] : null,
    };
  }
  private ref(
    id: string,
    actor: string,
    index: number,
    side: "reference" | "distorted",
  ): QualityEvidenceRef {
    const j = this.get(id, actor);
    if (!j.attemptId || !j.resultDigest)
      throw new AdminError(
        409,
        "Completed companion unavailable.",
        "vmaf-result-unavailable",
      );
    return {
      jobId: `${id}-f${index}`,
      attemptId: j.attemptId,
      digest: j.resultDigest,
      side,
    };
  }
  evidence(ref: QualityEvidenceRef, actor: string): QualityJobResult {
    const match = /^(vmaf-[a-f0-9-]{36})-f(\d{1,4})$/.exec(ref.jobId);
    if (!match)
      throw new AdminError(
        400,
        "Invalid VMAF companion reference.",
        "invalid-evidence-reference",
      );
    const j = this.get(match[1], actor);
    if (
      !terminalVmaf(j.state) ||
      j.attemptId !== ref.attemptId ||
      j.resultDigest !== ref.digest
    )
      throw new AdminError(
        409,
        "VMAF companion reference changed.",
        "evidence-unavailable",
      );
    const r = this.result(j.id, actor),
      index = Number(match[2]),
      value = structuredClone(r.prepared.pairs[index]);
    if (!value)
      throw new AdminError(
        404,
        "VMAF frame not found.",
        "vmaf-frame-not-found",
      );
    if (r.vmaf) {
      const association: VmafAssociation = {
        schema: "voidplayer-vmaf-sequence-association",
        version: value.version,
        jobId: j.id,
        attemptId: j.attemptId,
        resultDigest: j.resultDigest!,
        plan: r.plan,
        ...temporalWitness(r.prepared, index, digest),
        score: r.vmaf.frames[index].score,
        pooled: r.vmaf.pooled,
        component: r.vmaf.component,
        recipe: r.vmaf.recipe,
      };

      (value as typeof value & { sequenceVmaf: VmafAssociation }).sequenceVmaf =
        association;
    }
    return {
      schema: "voidplayer-quality-job-result",
      version: 1,
      jobId: ref.jobId,
      attemptId: ref.attemptId,
      completedAt: j.endedAt!,
      submitted: {
        actorId: j.actor.id,
        actorName: j.actor.name,
        client: j.input.client,
        requestId: j.requestId,
        idempotencyKey: j.key,
      },
      value,
    };
  }
  private policy(value: unknown): CandidatePolicy {
    const p = value as CandidatePolicy;
    if (
      !p ||
      typeof p !== "object" ||
      Object.keys(p).sort().join(",") !==
        "limit,maxScore,minFrameDistance,severity,side,space,text" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(p.space) ||
      !["reference", "distorted"].includes(p.side) ||
      !Number.isFinite(p.maxScore) ||
      p.maxScore < 0 ||
      p.maxScore > 100 ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > 8 ||
      !Number.isInteger(p.minFrameDistance) ||
      p.minFrameDistance < 1 ||
      p.minFrameDistance > VMAF_LIMITS.frames ||
      !Number.isInteger(p.severity) ||
      p.severity < 1 ||
      p.severity > 5 ||
      typeof p.text !== "string" ||
      !p.text.trim() ||
      p.text.length > 2000
    )
      throw new AdminError(
        400,
        "Provide explicit VMAF candidate threshold, text, severity and spacing.",
        "invalid-vmaf-policy",
      );
    return structuredClone(p);
  }
  publication(id: string, actor: string) {
    this.get(id, actor);
    return candidatePublication(this.db, 'vmaf', id);
  }
  publish(
    id: string,
    actor: Actor,
    value: unknown,
    origin: string,
    annotations: AnnotationStore,
    requestId: string,
  ) {
    this.available();
    const j = this.get(id, actor.id),
      policy = this.policy(value);
    return publishCandidates(this.db, 'vmaf', j, actor, policy, origin, annotations, requestId, () => {
      const r = this.result(id, actor.id);
      if (!r.vmaf || j.state !== "completed")
        throw new AdminError(
          409,
          "Completed VMAF result required.",
          "vmaf-result-unavailable",
        );
      const selected: number[] = [];
      for (const f of [...r.vmaf.frames].sort(
        (a, b) => a.score - b.score || a.index - b.index,
      ))
        if (
          f.score <= policy.maxScore &&
          selected.every(
            (i) => Math.abs(i - f.index) >= policy.minFrameDistance,
          )
        ) {
          selected.push(f.index);
          if (selected.length === policy.limit) break;
        }
      return selected.map(index => ({ index, ref: this.ref(id, actor.id, index, policy.side) }));
    }, ref => this.evidence(ref, actor.id));
  }
}
