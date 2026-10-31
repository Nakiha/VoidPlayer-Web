import { temporalWitness } from '../../../shared/analysis/quality/temporal-contract.ts';
import {
  TemporalScoringService,
  scoringDigest as digest,
  scoringNow as now,
} from "../quality/temporal-service.ts";
import { candidatePublication, publishCandidates } from '../quality/candidate-publication.ts';
import type { CandidatePolicy } from '../quality/candidate-publication.ts';
import { validatePreparedFacts } from '../quality/prepared-facts.ts';
import {
  comparisonLocation,
  pinComparison,
} from "../../../shared/analysis/quality/xpsnr-comparison.ts";
import type { XpsnrComparison } from "../../../shared/analysis/quality/xpsnr-comparison.ts";
import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { AdminError } from "../../admin-error.ts";
import type { Actor } from "../../identity.ts";
import type { CorrespondenceService } from "../quality/correspondence-service.ts";
import { qualityEvidenceValue } from "../../../shared/review/quality-evidence.ts";
import type { QualityEvidenceRef } from "../../../shared/review/quality-evidence.ts";
import type { QualityJobResult } from "../../../shared/analysis/quality/jobs.ts";
import type { AnnotationStore } from "../../annotations.ts";
import {
  xpsnrInput,
  canonicalJson,
  xpsnrSequenceFrame,
  XPSNR_LIMITS,
  terminalXpsnr,
  XpsnrError,
} from "../../../shared/analysis/quality/xpsnr.ts";
import type {
  XpsnrInput,
  XpsnrJob,
  XpsnrResult,
  XpsnrPlanSnapshot,
  XpsnrPrepared,
  XpsnrAssociation,
} from "../../../shared/analysis/quality/xpsnr.ts";
import type { WasmXpsnrRunner } from "./wasm-runner.ts";
import { clockKey } from "../../../shared/media/indexing/rational-clock.ts";
export class NativeXpsnrService extends TemporalScoringService<
  "xpsnr",
  XpsnrInput
> {
  constructor(
    file: string,
    runner: WasmXpsnrRunner,
    plans: CorrespondenceService,
  ) {
    super(file, runner, plans, "xpsnr", XPSNR_LIMITS);
    this.runner = runner;
  }
  protected metricError(code: string, message: string) {
    return new XpsnrError(code, message);
  }
  private runner: WasmXpsnrRunner;
  protected parse(value: unknown) {
    try {
      return xpsnrInput(value);
    } catch (error) {
      throw new AdminError(
        400,
        (error as Error).message,
        "invalid-xpsnr-request",
      );
    }
  }
  private cachedCapability: Awaited<
    ReturnType<WasmXpsnrRunner["capability"]>
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
        "xpsnr-plan-changed",
      );
    return this.runner.reexecutionPreflight(
      job.input,
      stored,
      expected,
      signal,
    );
  }
  protected validatePrepared(
    value: XpsnrPrepared,
    snapshot: XpsnrPlanSnapshot,
    input: XpsnrInput) {
    if (
      !value ||
      value.pairs.length < 2 ||
      value.pairs.length > XPSNR_LIMITS.frames ||
      canonicalJson(value.sequence.pairs) !==
        canonicalJson(
          [...snapshot.value.rangePlan!.input.pairs].sort(
            (a, b) => a.reference.sourcePtsUs - b.reference.sourcePtsUs,
          ),
        ) ||
      value.sequence.cadenceUs !== input.cadenceUs ||
      clockKey(
        value.sequence.cadence ?? {
          ticks: value.sequence.cadenceUs,
          timescale: 1000000,
        },
      ) !==
        clockKey(
          input.cadence ?? { ticks: input.cadenceUs, timescale: 1000000 },
        )
    )
      throw new XpsnrError(
        "worker-result-invalid",
        "Prepared sequence identity changed",
      );
    if (
      value.geometry.width < XPSNR_LIMITS.minDimension ||
      value.geometry.height < XPSNR_LIMITS.minDimension ||
      value.geometry.width > XPSNR_LIMITS.width ||
      value.geometry.height > XPSNR_LIMITS.height ||
      ![8, 10].includes(value.geometry.bitDepth)
    )
      throw new XpsnrError(
        "worker-result-invalid",
        "Prepared raw frame count/geometry differs",
      );
    validatePreparedFacts(value, snapshot, input, XPSNR_LIMITS.resultBytes, this.metricError);
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
        clockPairs: r.prepared.sequence.pairs.map((p, index) => ({
          referenceAu: p.reference.picture.au,
          distortedAu: p.distorted.picture.au,
          referencePtsUs: p.reference.sourcePtsUs,
          distortedPtsUs: p.distorted.sourcePtsUs,
          offsetUs: p.distorted.sourcePtsUs - p.reference.sourcePtsUs,
          ...Object.fromEntries(
            ["reference", "distorted"].map((side) => {
              const witness =
                r.prepared.pairs[index].result.provenance[
                  side as "reference" | "distorted"
                ];
              return [
                side + "Clock",
                witness.container
                  ? {
                      ticks:
                        witness.container.sample.dtsTicks +
                        witness.container.sample.ctsTicks,
                      timescale: witness.container.timescale,
                    }
                  : { ticks: witness.sourcePtsUs, timescale: 1000000 },
              ];
            }),
          ),
        })),
      },
      coverage: {
        scope: "selected-continuous-clip-not-whole-file",
        targetFrames: r.prepared.pairs.length,
        preparedFrames: r.prepared.pairs.length,
        xpsnrScoredFrames: r.xpsnr?.frames.length ?? 0,
        xpsnr: r.xpsnr ? "complete-selected-clip" : "unscored",
      },
      raw: r.prepared.raw,
      work: r.prepared.work,
      metrics: r.metrics,
      xpsnr: r.xpsnr,
      comparisonKey: r.xpsnr ? this.comparisonKey(r) : null,
      companionPairs: r.prepared.pairs.length,
      framesUrl: `/api/quality/xpsnr/jobs/${id}/frames`,
    };
  }
  private comparisonKey(r: XpsnrResult) {
    return digest({
      reference: r.prepared.pairs[0].sources.reference,
      frames: r.prepared.pairs.map((p) =>
        xpsnrSequenceFrame(p.result.provenance.reference),
      ),
      raw: r.prepared.raw.referenceSha256,
      recipe: r.xpsnr!.recipe,
      component: r.xpsnr!.component,
    });
  }
  compare(ids: string[], actor: string) {
    if (ids.length < 2 || ids.length > 4 || new Set(ids).size !== ids.length)
      throw new AdminError(
        400,
        "Select 2..4 distinct XPSNR jobs.",
        "invalid-comparison",
      );
    const items = ids.map((id) => {
      const job = this.get(id, actor),
        r = this.result(id, actor);
      if (job.state !== "completed" || !r.xpsnr)
        throw new AdminError(
          409,
          "Completed XPSNR required.",
          "xpsnr-result-unavailable",
        );
      return { job, r, key: this.comparisonKey(r) };
    });
    if (items.some((i) => i.key !== items[0].key))
      throw new AdminError(
        409,
        "Reference source, continuous clip, raw pixels or frozen implementation/recipe differ. Declare a new comparison intent.",
        "comparison-domain-mismatch",
      );
    const comparison: XpsnrComparison = {
      schema: "voidplayer-xpsnr-comparison",
      version: 1,
      comparisonKey: items[0].key,
      referenceIntegrity: "not-certified",
      perceptualSuperiority: "not-established",
      ranking:
        "caller-order; official pooled minimum is available, not a human judgment",
      reference: items[0].r.prepared.pairs[0].sources.reference,
      recipe: items[0].r.xpsnr!.recipe,
      items: items.map(({ job, r }) => ({
        id: job.id,
        attemptId: job.attemptId!,
        resultDigest: job.resultDigest!,
        label: r.prepared.pairs[0].annotationContext?.distorted.name,
        distorted: r.prepared.pairs[0].sources.distorted,
        raw: r.prepared.raw,
        pooled: r.xpsnr!.pooled,
        statisticsSha256: r.xpsnr!.statistics.sha256,
        result: `/api/quality/xpsnr/jobs/${job.id}/result`,
      })),
    };
    return {
      ...comparison,
      gui: comparisonLocation(pinComparison(comparison)),
    };
  }
  frames(
    id: string,
    actor: string,
    after = 0,
    limit: number = XPSNR_LIMITS.page,
  ) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > XPSNR_LIMITS.page
    )
      throw new AdminError(400, "Invalid XPSNR frame page.", "invalid-cursor");
    const r = this.result(id, actor),
      indices = r.prepared.pairs.map((_, i) => i).filter((i) => i >= after);
    return {
      entries: indices.slice(0, limit).map((index) => ({
        index,
        score: r.xpsnr?.frames[index]?.minimum ?? null,
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
        "xpsnr-result-unavailable",
      );
    return {
      jobId: `${id}-f${index}`,
      attemptId: j.attemptId,
      digest: j.resultDigest,
      side,
    };
  }
  evidence(ref: QualityEvidenceRef, actor: string): QualityJobResult {
    const match = /^(xpsnr-[a-f0-9-]{36})-f(\d{1,4})$/.exec(ref.jobId);
    if (!match)
      throw new AdminError(
        400,
        "Invalid XPSNR companion reference.",
        "invalid-evidence-reference",
      );
    const j = this.get(match[1], actor);
    if (
      !terminalXpsnr(j.state) ||
      j.attemptId !== ref.attemptId ||
      j.resultDigest !== ref.digest
    )
      throw new AdminError(
        409,
        "XPSNR companion reference changed.",
        "evidence-unavailable",
      );
    const r = this.result(j.id, actor),
      index = Number(match[2]),
      value = structuredClone(r.prepared.pairs[index]);
    if (!value)
      throw new AdminError(
        404,
        "XPSNR frame not found.",
        "xpsnr-frame-not-found",
      );
    if (r.xpsnr) {
      const association: XpsnrAssociation = {
        schema: "voidplayer-xpsnr-sequence-association",
        version: value.version,
        jobId: j.id,
        attemptId: j.attemptId,
        resultDigest: j.resultDigest!,
        plan: r.plan,
        ...temporalWitness(r.prepared, index, digest),
        planes: r.xpsnr.frames[index].planes,
        pooled: r.xpsnr.pooled,
        component: r.xpsnr.component,
        recipe: r.xpsnr.recipe,
        statisticsSha256: r.xpsnr.statistics.sha256,
      };

      (
        value as typeof value & { sequenceXpsnr: XpsnrAssociation }
      ).sequenceXpsnr = association;
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
      p.maxScore > 200 ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > 8 ||
      !Number.isInteger(p.minFrameDistance) ||
      p.minFrameDistance < 1 ||
      p.minFrameDistance > XPSNR_LIMITS.frames ||
      !Number.isInteger(p.severity) ||
      p.severity < 1 ||
      p.severity > 5 ||
      typeof p.text !== "string" ||
      !p.text.trim() ||
      p.text.length > 2000
    )
      throw new AdminError(
        400,
        "Provide explicit XPSNR candidate threshold, text, severity and spacing.",
        "invalid-xpsnr-policy",
      );
    return structuredClone(p);
  }
  publication(id: string, actor: string) {
    this.get(id, actor);
    return candidatePublication(this.db, 'xpsnr', id);
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
    return publishCandidates(this.db, 'xpsnr', j, actor, policy, origin, annotations, requestId, () => {
      const r = this.result(id, actor.id);
      if (!r.xpsnr || j.state !== "completed")
        throw new AdminError(
          409,
          "Completed XPSNR result required.",
          "xpsnr-result-unavailable",
        );
      const selected: number[] = [];
      for (const f of [...r.xpsnr.frames]
        .filter((f) => f.minimum.kind === "finite")
        .sort((a, b) => a.minimum.db! - b.minimum.db! || a.index - b.index))
        if (
          f.minimum.db! <= policy.maxScore &&
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
