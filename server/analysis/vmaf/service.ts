import {
  TemporalScoringService,
  scoringDigest as digest,
  scoringNow as now,
} from "../quality/temporal-service.ts";
import { settleScoringReservations } from "../quality/result-retention.ts";
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { sameExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
  vmafSequenceFrame,
  VMAF_LIMITS,
  terminalVmaf,
  VmafError,
} from "../../../shared/analysis/quality/vmaf.ts";
import type {
  VmafInput,
  VmafJob,
  VmafResult,
  VmafPlanSnapshot,
  VmafPrepared,
  VmafAssociation,
} from "../../../shared/analysis/quality/vmaf.ts";
import type { WasmVmafRunner } from "./wasm-runner.ts";

const reason = (error: unknown) => ({
  code:
    typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : "execution-failed",
  message:
    error instanceof Error
      ? error.message.slice(0, 300)
      : "VMAF execution failed",
});
type Publication = {
  policy: CandidatePolicy;
  selected: {
    index: number;
    id: string;
    operationId: string;
    ref: QualityEvidenceRef;
  }[];
  createdIds: string[];
};
type CandidatePolicy = {
  space: string;
  side: "reference" | "distorted";
  maxScore: number;
  limit: number;
  minFrameDistance: number;
  text: string;
  severity: number;
};
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
  private validatePrepared(
    value: VmafPrepared,
    snapshot: VmafPlanSnapshot,
    input: VmafInput,
  ) {
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
      value.pairs.length !== value.sequence.pairs.length ||
      value.geometry.width < VMAF_LIMITS.minDimension ||
      value.geometry.height < VMAF_LIMITS.minDimension ||
      value.geometry.width > VMAF_LIMITS.width ||
      value.geometry.height > VMAF_LIMITS.height ||
      ![8, 10].includes(value.geometry.bitDepth) ||
      value.raw.bytes !==
        ((value.geometry.width * value.geometry.height * 3) / 2) *
          (value.geometry.bitDepth === 8 ? 1 : 2) *
          value.pairs.length *
          2 ||
      [value.raw.referenceSha256, value.raw.distortedSha256].some(
        (h) => !/^[a-f0-9]{64}$/.test(h),
      )
    )
      throw new VmafError(
        "worker-result-invalid",
        "Prepared raw frame count/geometry differs",
      );
    for (const [index, pair] of value.pairs.entries()) {
      qualityEvidenceValue(pair);
      const expected = value.sequence.pairs[index];
      if (
        canonicalJson(pair.result.metric.roi) !== canonicalJson(expected.roi) ||
        pair.result.metric.bitDepth !== value.geometry.bitDepth ||
        !!pair.result.ssim !== input.metrics.ssim
      )
        throw new VmafError(
          "worker-result-invalid",
          "Prepared metric recipe changed",
        );
      for (const side of ["reference", "distorted"] as const) {
        const p = pair.result.provenance[side],
          e = expected[side];
        for (const field of [
          "mediaId",
          "mediaVersion",
          "size",
          "indexIdentity",
          "indexBuildId",
          "sourcePtsUs",
          "picture",
          "decode",
        ] as const)
          if (canonicalJson(p[field]) !== canonicalJson(e[field]))
            throw new VmafError(
              "worker-result-invalid",
              "Prepared source/picture identity changed",
            );
      }
    }
    const budget = snapshot.value.rangePlan!.input.budget;
    if (
      value.work.readBytes > budget.maxReadBytes ||
      value.work.packets > budget.maxPackets ||
      value.work.outputFrames > budget.maxOutputFrames ||
      value.work.inputBytes > budget.maxInputBytes
    )
      throw new VmafError(
        "worker-result-invalid",
        "Prepared work exceeds frozen total budget",
      );
    if (
      value.raw.bytes > input.budget.maxRawBytes ||
      Buffer.byteLength(JSON.stringify(value)) > VMAF_LIMITS.resultBytes
    )
      throw new VmafError(
        "budget-exceeded",
        "Prepared sequence result budget exceeded",
      );
  }
  protected async execute(id: string, signal: AbortSignal) {
    let j = this.get(id, this.all().find((x) => x.id === id)!.actor.id);
    const snapshot = JSON.parse(
      String(
        this.db
          .prepare("SELECT snapshot FROM quality_vmaf_jobs WHERE id=?")
          .get(id)!.snapshot,
      ),
    ) as VmafPlanSnapshot;
    try {
      const value = await this.runner.run(j.input, snapshot, signal, {
        expectedExecutionContract: j.executionContract,
        contract: (contract) => {
          j = this.get(id, j.actor.id);
          if (
            Buffer.byteLength(JSON.stringify(contract)) > 16 * 1024 ||
            (j.executionContract &&
              !sameExecutionContract(j.executionContract, contract))
          )
            throw new AdminError(
              409,
              "Frozen native execution contract changed.",
              "execution-contract-conflict",
            );
          if (!j.executionContract) {
            j.executionContract = contract;
            this.save(j);
          }
        },
        admitted: () => {
          j = this.get(id, j.actor.id);
          if (j.state !== "queued" || j.queueUntil <= now())
            throw new VmafError(
              "queue-expired",
              "VMAF queue changed before admission",
            );
          j.state = "preparing";
          j.phase = "component";
          j.startedAt = now();
          j.reason = null;
          j.attemptId = randomUUID();
          j.metrics.psnr.state = "running";
          if (j.input.metrics.ssim) j.metrics.ssim.state = "running";
          this.save(j);
        },
        phase: (phase) => {
          j = this.get(id, j.actor.id);
          j.phase = phase;
          if (phase === "native" || phase === "decode-and-score") {
            j.state = "running";
            j.metrics.vmaf.state = "running";
          }
          this.save(j);
        },
        progress: (frames, total) => {
          j = this.get(id, j.actor.id);
          j.progress = { preparedFrames: frames, targetFrames: total };
          this.save(j);
        },
        prepared: (value) => {
          this.validatePrepared(value, snapshot, j.input);
          j = this.get(id, j.actor.id);
          j.metrics.psnr = { state: "completed", reason: null };
          if (j.input.metrics.ssim)
            j.metrics.ssim = { state: "completed", reason: null };
          this.db.exec("BEGIN IMMEDIATE");
          try {
            this.db
              .prepare("UPDATE quality_vmaf_jobs SET prepared=? WHERE id=?")
              .run(JSON.stringify(value), id);
            this.save(j);
            this.db.exec("COMMIT");
          } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
          }
        },
        process: (process) => {
          j = this.get(id, j.actor.id);
          j.process = process;
          this.save(j);
        },
      });
      j = this.get(id, j.actor.id);
      j.metrics.vmaf = { state: "completed", reason: null };
      j.state = j.state === "cancelling" ? "cancelled" : "completed";
      j.reason = null;
      j.phase = "done";
      j.endedAt = now();
      this.finish(j, value.native);
    } catch (error) {
      if (this.runner.stopUncertain) throw error;
      j = this.get(id, j.actor.id);
      if (terminalVmaf(j.state)) return;
      if (
        !j.attemptId &&
        error instanceof AdminError &&
        error.code === "quality-busy"
      ){this.blocked(j,error);return;}
      j.reason = reason(error);
      const cancelled = j.state === "cancelling" || signal.aborted;
      for (const m of Object.values(j.metrics))
        if (["waiting", "running"].includes(m.state)) {
          m.state = this.closed
            ? "interrupted"
            : cancelled
              ? "cancelled"
              : "failed";
          m.reason = j.reason;
        }
      j.state = this.closed
        ? "interrupted"
        : cancelled
          ? "cancelled"
          : this.prepared(j.id)
            ? "partial"
            : "failed";
      j.phase = "done";
      j.process = null;
      j.endedAt = now();
      this.finish(j, null);
    }
  }
  protected finish(job: VmafJob, native: VmafResult["vmaf"]) {
    const prepared = this.prepared(job.id);
    let result: VmafResult | null = null;
    if (prepared) {
      result = {
        schema: "voidplayer-native-vmaf-result",
        version: prepared.pairs[0].version,
        plan: { ...job.input.plan },
        prepared,
        vmaf: native,
        metrics: structuredClone(job.metrics),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > VMAF_LIMITS.resultBytes)
        throw new VmafError(
          "budget-exceeded",
          "VMAF result history limit exceeded",
        );
      job.resultDigest = digest(result);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE quality_vmaf_jobs SET result=?,prepared=NULL WHERE id=?",
        )
        .run(result ? JSON.stringify(result) : null, job.id);
      this.save(job);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  result(id: string, actor: string) {
    const j = this.get(id, actor);
    const row = this.db
      .prepare("SELECT result FROM quality_vmaf_jobs WHERE id=?")
      .get(id);
    if (!row?.result || !j.resultDigest)
      throw new AdminError(
        409,
        "Immutable VMAF result is unavailable.",
        "vmaf-result-unavailable",
      );
    const value = JSON.parse(String(row.result)) as VmafResult;
    if (digest(value) !== j.resultDigest)
      throw new AdminError(
        500,
        "Stored VMAF result changed.",
        "stored-vmaf-invalid",
      );
    return value;
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
        sequence: {
          cadenceUs: r.prepared.sequence.cadenceUs,
          ...(r.prepared.sequence.cadence
            ? { cadence: r.prepared.sequence.cadence }
            : {}),
          referenceIntegrity: "not-certified",
          concealmentDetection: "unavailable",
          pairs: r.prepared.pairs.map((p) => ({
            reference: vmafSequenceFrame(p.result.provenance.reference),
            distorted: vmafSequenceFrame(p.result.provenance.distorted),
          })),
        },
        index,
        frames: r.prepared.pairs.length,
        score: r.vmaf.frames[index].score,
        pooled: r.vmaf.pooled,
        component: r.vmaf.component,
        recipe: r.vmaf.recipe,
        raw: r.prepared.raw,
        spatial: ((roi) =>
          roi.x !== 0 ||
          roi.y !== 0 ||
          roi.width !==
            r.prepared.pairs[index].result.provenance.reference.decoded
              .description.width ||
          roi.height !==
            r.prepared.pairs[index].result.provenance.reference.decoded
              .description.height)(r.prepared.sequence.pairs[index].roi)
          ? "cropped-region-temporal-score-not-localized"
          : "full-frame-temporal-score-not-localized",
      };
      if (association.frames > 32) {
        const pairs = association.sequence.pairs,
          indices = [...new Set([0, index, pairs.length - 1])].sort(
            (a, b) => a - b,
          );
        association.sequence = {
          ...association.sequence,
          indices,
          pairsSha256: digest(pairs),
          pairs: indices.map((i) => pairs[i]),
        };
      }
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
      p.minFrameDistance > 32 ||
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
    const row = this.db
      .prepare("SELECT body FROM quality_vmaf_publications WHERE job_id=?")
      .get(id);
    return row ? (JSON.parse(String(row.body)) as Publication) : null;
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
    let publication = this.publication(id, actor.id);
    if (
      publication &&
      canonicalJson(publication.policy) !== canonicalJson(policy)
    )
      throw new AdminError(
        409,
        "Candidate policy is already frozen.",
        "candidate-policy-conflict",
      );
    if (!publication) {
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
      publication = {
        policy,
        selected: selected.map((index) => ({
          index,
          id: randomUUID(),
          operationId: randomUUID(),
          ref: this.ref(id, actor.id, index, policy.side),
        })),
        createdIds: [],
      };
      this.db
        .prepare("INSERT INTO quality_vmaf_publications VALUES(?,?)")
        .run(id, JSON.stringify(publication));
      settleScoringReservations(this.db, "vmaf", id);
    }
    for (const item of publication.selected) {
      annotations.mutate(
        policy.space,
        {
          action: "create-quality-candidate",
          operationId: item.operationId,
          id: item.id,
          revision: 0,
          client: {
            kind:
              j.input.client.kind === "browser"
                ? "gui"
                : j.input.client.kind === "agent"
                  ? "agent"
                  : "http",
            id: "vmaf_" + j.id,
          },
          evidence: item.ref,
          candidate: { text: policy.text, severity: policy.severity },
        },
        actor,
        requestId,
        { origin, resolve: (ref) => this.evidence(ref, actor.id) },
      );
      if (!publication.createdIds.includes(item.id)) {
        publication.createdIds.push(item.id);
        this.db
          .prepare("UPDATE quality_vmaf_publications SET body=? WHERE job_id=?")
          .run(JSON.stringify(publication), id);
        settleScoringReservations(this.db, "vmaf", id);
      }
    }
    return publication;
  }
}
