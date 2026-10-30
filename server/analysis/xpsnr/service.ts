import {
  reserveScoringBytes,
  settleScoringReservations,
  releaseScoringResult,
} from "../quality/result-retention.ts";
import {
  comparisonLocation,
  pinComparison,
} from "../../../shared/analysis/quality/xpsnr-comparison.ts";
import type { XpsnrComparison } from "../../../shared/analysis/quality/xpsnr-comparison.ts";
import { ReexecutionLedger } from "../quality/reexecution-ledger.ts";
import type { ReexecutionCreation } from "../quality/reexecution-ledger.ts";
import type {
  QualityExecutionContract,
  ReexecutionRequest,
} from "../../../shared/analysis/quality/reexecution.ts";
import { sameExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { taskSummaries, taskEdges } from "../../tasks/summary.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { openIndexDatabase } from "../../sqlite.ts";
import { lockDatabase } from "../../library-store.ts";
import { AdminError } from "../../admin-error.ts";
import type { Actor } from "../../identity.ts";
import type { CorrespondenceService } from "../quality/correspondence-service.ts";
import { qualityIdempotencyKey } from "../quality/job-request.ts";
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
import { stopOwnedNative } from "../quality/legacy-process.ts";
import type { WasmXpsnrRunner } from "./wasm-runner.ts";
import { clockKey } from "../../../shared/media/indexing/rational-clock.ts";
const digest = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");
const now = () => Math.floor(performance.timeOrigin + performance.now());
const waiting = () => ({ state: "waiting" as const, reason: null });
const reason = (error: unknown) => ({
  code:
    typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : "execution-failed",
  message:
    error instanceof Error
      ? error.message.slice(0, 300)
      : "XPSNR execution failed",
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
/** Separate metric outcomes, one service-owned attempt, no automatic retry/work sharing. */
export class NativeXpsnrService {
  readonly reexecutions: ReexecutionLedger;
  taskSummaries(
    actor: string,
    id?: string,
    filter?: import("../../../shared/service/tasks.ts").TaskFilter,
  ) {
    return taskSummaries(this.db, "xpsnr", actor, id, filter);
  }
  taskEdges(actor: string, id?: string) {
    return taskEdges(this.db, "xpsnr", actor, id);
  }

  private db: ReturnType<typeof openIndexDatabase>;
  private unlock: () => void;
  readonly ready: Promise<void>;
  private recovered = false;
  private closed = false;
  private fatal: unknown;
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private file: string;
  private runner: WasmXpsnrRunner;
  private plans: CorrespondenceService;
  constructor(
    file: string,
    runner: WasmXpsnrRunner,
    plans: CorrespondenceService,
  ) {
    this.file = file;
    this.runner = runner;
    this.plans = plans;
    mkdirSync(path.dirname(file), { recursive: true });
    this.unlock = lockDatabase(file);
    let db: ReturnType<typeof openIndexDatabase> | undefined;
    try {
      this.db = db = openIndexDatabase(file);
      db.exec("PRAGMA busy_timeout=0;");
      if (Number(db.prepare("PRAGMA user_version").get()!.user_version) > 2)
        throw new AdminError(
          409,
          "XPSNR history requires a newer application.",
          "future-xpsnr-schema",
        );
      db.exec(
        `PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;CREATE TABLE IF NOT EXISTS quality_xpsnr_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,snapshot TEXT NOT NULL,prepared TEXT,result TEXT,reserved INTEGER NOT NULL,UNIQUE(actor,client,key));CREATE TABLE IF NOT EXISTS quality_xpsnr_publications(job_id TEXT PRIMARY KEY,body TEXT NOT NULL);`,
      );
      this.reexecutions = new ReexecutionLedger(db);
      db.exec("PRAGMA user_version=2;COMMIT;");
    } catch (error) {
      db?.close();
      this.unlock();
      throw error;
    }
    this.ready = this.recover();
    void this.ready.catch((error) => {
      this.fatal = error;
    });
  }
  private async recover() {
    for (const job of this.all())
      if (!terminalXpsnr(job.state)) {
        if (job.process) await stopOwnedNative(job.process);
        job.state = "interrupted";
        job.phase = "done";
        job.endedAt = now();
        job.process = null;
        job.reason = {
          code: "service-restarted",
          message:
            "Previous execution interrupted; completed companion facts retained without retry.",
        };
        for (const m of Object.values(job.metrics))
          if (["waiting", "running"].includes(m.state)) {
            m.state = "interrupted";
            m.reason = job.reason;
          }
        this.finish(job, null);
      }
    // Exactly one prior executor could own raw files. No new work starts before
    // every durably recorded supervisor above has physically exited.
    rmSync(this.file.replace(/\.quality-xpsnr\.sqlite$/, ".xpsnr-tmp"), {
      recursive: true,
      force: true,
    });
    this.recovered = true;
  }
  private available() {
    if (
      this.closed ||
      this.fatal ||
      !this.recovered ||
      this.runner.stopUncertain
    )
      throw new AdminError(
        503,
        "XPSNR service unavailable or recovering.",
        "xpsnr-service-unavailable",
      );
  }
  private all() {
    return this.db
      .prepare(
        `SELECT body FROM quality_xpsnr_jobs WHERE json_extract(body,'$.state') IN ('queued','preparing','running','cancelling') ORDER BY rowid`,
      )
      .all()
      .map((r) => JSON.parse(String(r.body)) as XpsnrJob);
  }
  private save(job: XpsnrJob) {
    job.revision++;
    this.db
      .prepare("UPDATE quality_xpsnr_jobs SET body=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
    if (terminalXpsnr(job.state))
      settleScoringReservations(this.db, "xpsnr", job.id);
  }
  get(id: string, actor: string) {
    const row = this.db
      .prepare(
        "SELECT body,fingerprint FROM quality_xpsnr_jobs WHERE id=? AND actor=?",
      )
      .get(id, actor);
    if (!row)
      throw new AdminError(404, "XPSNR job not found.", "xpsnr-not-found");
    const job = JSON.parse(String(row.body)) as XpsnrJob;
    if (digest(job.input) !== row.fingerprint)
      throw new AdminError(
        500,
        "Stored XPSNR request changed.",
        "stored-xpsnr-invalid",
      );
    return job;
  }
  history(actor: string, after = 0, limit = 8) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 16
    )
      throw new AdminError(400, "Invalid XPSNR cursor.", "invalid-cursor");
    const rows = this.db
      .prepare(
        "SELECT rowid,body FROM quality_xpsnr_jobs WHERE actor=? AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(actor, after, limit + 1);
    return {
      entries: rows.slice(0, limit).map((r) => JSON.parse(String(r.body))),
      after: rows.length
        ? Number(rows[Math.min(limit, rows.length) - 1].rowid)
        : after,
      more: rows.length > limit,
    };
  }
  private parse(value: unknown) {
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
  private snapshot(input: XpsnrInput, actor: string): XpsnrPlanSnapshot {
    const plan = this.plans.get(input.plan.id, actor);
    if (
      plan.state !== "completed" ||
      plan.attemptId !== input.plan.attemptId ||
      plan.resultDigest !== input.plan.digest
    )
      throw new AdminError(
        409,
        "Pin a completed correspondence attempt/digest.",
        "xpsnr-plan-changed",
      );
    return { ...input.plan, value: this.plans.result(plan.id, actor) };
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
  submit(
    value: unknown,
    actor: Actor,
    requestId: string,
    key: unknown,
    reexecution?: ReexecutionCreation,
  ) {
    this.available();
    const input = this.parse(value),
      k = qualityIdempotencyKey(key),
      fingerprint = digest(input);
    this.db.exec("BEGIN IMMEDIATE");
    let accepted: { job: XpsnrJob; replayed: boolean };
    try {
      accepted = (() => {
        if (reexecution) {
          const prior = this.reexecutions.replay(
            reexecution.parentId,
            actor.id,
            reexecution.key,
            reexecution.request,
          );
          if (prior)
            return {
              job: this.reexecutions.verify(
                prior,
                this.get(prior.jobId, actor.id),
              ),
              replayed: true,
            };
          const parent = this.get(reexecution.parentId, actor.id);
          if (
            parent.revision !== reexecution.parentRevision ||
            !["failed", "partial", "interrupted", "cancelled"].includes(
              parent.state,
            ) ||
            parent.endedAt === null ||
            parent.process
          )
            throw new AdminError(
              409,
              "Original native execution has not physically stopped.",
              "reexecution-blocked",
            );
        }
        const prior = this.db
          .prepare(
            "SELECT id,fingerprint FROM quality_xpsnr_jobs WHERE actor=? AND client=? AND key=?",
          )
          .get(actor.id, input.client.id, k);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AdminError(
              409,
              "XPSNR key binds a different recipe.",
              "idempotency-conflict",
            );
          return { job: this.get(String(prior.id), actor.id), replayed: true };
        }
        this.runner.assertAvailable();
        const snapshot = this.snapshot(input, actor.id),
          all = this.all(),
          live = all.filter((j) => !terminalXpsnr(j.state));
        if (
          live.length >= XPSNR_LIMITS.queued ||
          live.filter((j) => j.actor.id === actor.id).length >=
            XPSNR_LIMITS.actorOutstanding
        )
          throw new AdminError(
            429,
            "XPSNR bounded queue is full.",
            "xpsnr-queue-full",
          );
        settleScoringReservations(this.db, "xpsnr");
        const reserved = reserveScoringBytes(
            XPSNR_LIMITS.resultBytes,
            input,
            snapshot,
          ),
          used = Number(
            this.db
              .prepare(
                "SELECT coalesce(sum(reserved),0) AS n FROM quality_xpsnr_jobs",
              )
              .get()!.n,
          );
        if (used + reserved > XPSNR_LIMITS.reservedBytes)
          throw new AdminError(
            429,
            "XPSNR history budget is full; old receipts retained.",
            "xpsnr-history-full",
          );
        const createdAt = now(),
          job: XpsnrJob = {
            ...(reexecution
              ? {
                  executionContract: reexecution.contract,
                  retryOf: reexecution.lineage,
                }
              : {}),
            schema: "voidplayer-native-xpsnr-job-state",
            version: 1,
            id: "xpsnr-" + randomUUID(),
            actor: { id: actor.id, name: actor.name },
            key: k,
            requestId,
            input,
            revision: 1,
            createdAt,
            queueUntil: createdAt + XPSNR_LIMITS.queueWaitMs,
            startedAt: null,
            endedAt: null,
            attemptId: null,
            state: "queued",
            phase: "queued",
            reason: null,
            progress: {
              preparedFrames: 0,
              targetFrames: snapshot.value.rangePlan?.input.pairs.length ?? 0,
            },
            metrics: {
              psnr: waiting(),
              ssim: input.metrics.ssim
                ? waiting()
                : { state: "not-requested", reason: null },
              xpsnr: waiting(),
            },
            resultDigest: null,
            process: null,
          };
        this.db
          .prepare(
            "INSERT INTO quality_xpsnr_jobs VALUES(?,?,?,?,?,?,?,NULL,NULL,?)",
          )
          .run(
            job.id,
            actor.id,
            input.client.id,
            k,
            fingerprint,
            JSON.stringify(job),
            JSON.stringify(snapshot),
            reserved,
          );
        if (reexecution)
          this.reexecutions.insert({
            actorId: actor.id,
            parentId: reexecution.parentId,
            jobId: job.id,
            key: reexecution.key,
            request: reexecution.request,
            lineage: reexecution.lineage,
          });
        return { job: this.get(job.id, actor.id), replayed: false };
      })();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!accepted.replayed) this.pump();
    return { ...accepted, job: this.get(accepted.job.id, actor.id) };
  }
  reexecutionReceipt(
    id: string,
    actor: string,
    key?: string,
    request?: ReexecutionRequest,
  ) {
    this.get(id, actor);
    const receipt =
      key && request
        ? this.reexecutions.replay(id, actor, key, request)
        : this.reexecutions.get(id, actor);
    if (receipt)
      this.reexecutions.verify(receipt, this.get(receipt.jobId, actor));
    return receipt;
  }
  frozenSnapshot(id: string, actor: string) {
    const job = this.get(id, actor),
      snapshot = JSON.parse(
        String(
          this.db
            .prepare("SELECT snapshot FROM quality_xpsnr_jobs WHERE id=?")
            .get(id)!.snapshot,
        ),
      ) as XpsnrPlanSnapshot;
    if (
      snapshot.id !== job.input.plan.id ||
      snapshot.attemptId !== job.input.plan.attemptId ||
      snapshot.digest !== job.input.plan.digest ||
      digest(snapshot.value) !== snapshot.digest
    )
      throw new AdminError(
        409,
        "Frozen XPSNR C plan snapshot changed.",
        "stored-input-invalid",
      );
    return snapshot;
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
  reexecute(creation: ReexecutionCreation, actor: Actor, requestId: string) {
    this.available();
    const original = this.get(creation.parentId, actor.id);
    return this.submit(
      original.input,
      actor,
      requestId,
      "reexecution:" + randomUUID(),
      creation,
    );
  }
  private wake() {
    if (
      this.timer ||
      this.closed ||
      this.fatal ||
      !this.all().some((j) => j.state === "queued")
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 250);
    this.timer.unref();
  }
  private pump() {
    if (this.active || this.closed || this.fatal || !this.recovered) return;
    for (const j of this.all().filter(
      (j) => j.state === "queued" && j.queueUntil <= now(),
    )) {
      j.reason = {
        code: "queue-expired",
        message: "XPSNR queue deadline exceeded before execution",
      };
      j.state = "failed";
      j.phase = "done";
      j.endedAt = now();
      for (const m of Object.values(j.metrics))
        if (m.state === "waiting") {
          m.state = "failed";
          m.reason = j.reason;
        }
      this.finish(j, null);
    }
    const job = this.all().find((j) => j.state === "queued");
    if (!job) return;
    const active = {
      id: job.id,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = this.execute(job.id, active.controller.signal)
      .catch((error) => {
        this.fatal = error;
        console.error("XPSNR service stopped; durable history retained.");
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
        this.wake();
      });
  }
  private prepared(id: string) {
    const row = this.db
      .prepare("SELECT prepared FROM quality_xpsnr_jobs WHERE id=?")
      .get(id);
    return row?.prepared
      ? (JSON.parse(String(row.prepared)) as XpsnrPrepared)
      : null;
  }
  private validatePrepared(
    value: XpsnrPrepared,
    snapshot: XpsnrPlanSnapshot,
    input: XpsnrInput,
  ) {
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
      value.pairs.length !== value.sequence.pairs.length ||
      value.geometry.width < XPSNR_LIMITS.minDimension ||
      value.geometry.height < XPSNR_LIMITS.minDimension ||
      value.geometry.width > XPSNR_LIMITS.width ||
      value.geometry.height > XPSNR_LIMITS.height ||
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
      throw new XpsnrError(
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
        throw new XpsnrError(
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
            throw new XpsnrError(
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
      throw new XpsnrError(
        "worker-result-invalid",
        "Prepared work exceeds frozen total budget",
      );
    if (
      value.raw.bytes > input.budget.maxRawBytes ||
      Buffer.byteLength(JSON.stringify(value)) > XPSNR_LIMITS.resultBytes
    )
      throw new XpsnrError(
        "budget-exceeded",
        "Prepared sequence result budget exceeded",
      );
  }
  private async execute(id: string, signal: AbortSignal) {
    let j = this.get(id, this.all().find((x) => x.id === id)!.actor.id);
    const snapshot = JSON.parse(
      String(
        this.db
          .prepare("SELECT snapshot FROM quality_xpsnr_jobs WHERE id=?")
          .get(id)!.snapshot,
      ),
    ) as XpsnrPlanSnapshot;
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
            throw new XpsnrError(
              "queue-expired",
              "XPSNR queue changed before admission",
            );
          j.state = "preparing";
          j.phase = "component";
          j.startedAt = now();
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
            j.metrics.xpsnr.state = "running";
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
              .prepare("UPDATE quality_xpsnr_jobs SET prepared=? WHERE id=?")
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
      j.metrics.xpsnr = { state: "completed", reason: null };
      j.state = j.state === "cancelling" ? "cancelled" : "completed";
      j.reason = null;
      j.phase = "done";
      j.endedAt = now();
      this.finish(j, value.native);
    } catch (error) {
      if (this.runner.stopUncertain) throw error;
      j = this.get(id, j.actor.id);
      if (terminalXpsnr(j.state)) return;
      if (
        !j.attemptId &&
        error instanceof AdminError &&
        error.code === "quality-busy"
      )
        return;
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
  private finish(job: XpsnrJob, native: XpsnrResult["xpsnr"]) {
    const prepared = this.prepared(job.id);
    let result: XpsnrResult | null = null;
    if (prepared) {
      result = {
        schema: "voidplayer-native-xpsnr-result",
        version: prepared.pairs[0].version,
        plan: { ...job.input.plan },
        prepared,
        xpsnr: native,
        metrics: structuredClone(job.metrics),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > XPSNR_LIMITS.resultBytes)
        throw new XpsnrError(
          "budget-exceeded",
          "XPSNR result history limit exceeded",
        );
      job.resultDigest = digest(result);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE quality_xpsnr_jobs SET result=?,prepared=NULL WHERE id=?",
        )
        .run(result ? JSON.stringify(result) : null, job.id);
      this.save(job);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  releaseResult(id: string, actor: string) {
    this.available();
    const j = this.get(id, actor);
    if (!terminalXpsnr(j.state) || j.process || this.active?.id === id)
      throw new AdminError(
        409,
        "Wait for physical task completion before releasing results.",
        "result-still-running",
      );
    if (
      this.db
        .prepare("SELECT 1 FROM quality_xpsnr_publications WHERE job_id=?")
        .get(id)
    )
      throw new AdminError(
        409,
        "A frozen publication retains this result.",
        "result-publication-pinned",
      );
    releaseScoringResult(this.db, "xpsnr", id);
    return { jobId: id, released: true, receiptRetained: true };
  }
  cancel(id: string, actor: string) {
    this.available();
    const j = this.get(id, actor);
    if (terminalXpsnr(j.state)) return j;
    if (j.state === "queued") {
      if (this.active?.id === id)
        this.active.controller.abort(
          new XpsnrError("cancelled", "XPSNR cancelled before admission"),
        );
      j.state = "cancelled";
      j.phase = "done";
      j.endedAt = now();
      j.reason = {
        code: "cancelled",
        message: "XPSNR cancelled before execution",
      };
      for (const m of Object.values(j.metrics))
        if (m.state === "waiting") {
          m.state = "cancelled";
          m.reason = j.reason;
        }
      this.finish(j, null);
    } else {
      j.state = "cancelling";
      j.phase = "stopping";
      this.save(j);
      if (this.active?.id === id)
        this.active.controller.abort(
          new XpsnrError("cancelled", "XPSNR explicitly cancelled"),
        );
    }
    return this.get(id, actor);
  }
  result(id: string, actor: string) {
    const j = this.get(id, actor);
    const row = this.db
      .prepare("SELECT result FROM quality_xpsnr_jobs WHERE id=?")
      .get(id);
    if (!row?.result || !j.resultDigest)
      throw new AdminError(
        409,
        "Immutable XPSNR result is unavailable.",
        "xpsnr-result-unavailable",
      );
    const value = JSON.parse(String(row.result)) as XpsnrResult;
    if (digest(value) !== j.resultDigest)
      throw new AdminError(
        500,
        "Stored XPSNR result changed.",
        "stored-xpsnr-invalid",
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
      entries: indices
        .slice(0, limit)
        .map((index) => ({
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
        sequence: {
          cadenceUs: r.prepared.sequence.cadenceUs,
          ...(r.prepared.sequence.cadence
            ? { cadence: r.prepared.sequence.cadence }
            : {}),
          referenceIntegrity: "not-certified",
          concealmentDetection: "unavailable",
          pairs: r.prepared.pairs.map((p) => ({
            reference: xpsnrSequenceFrame(p.result.provenance.reference),
            distorted: xpsnrSequenceFrame(p.result.provenance.distorted),
          })),
        },
        index,
        frames: r.prepared.pairs.length,
        planes: r.xpsnr.frames[index].planes,
        pooled: r.xpsnr.pooled,
        component: r.xpsnr.component,
        recipe: r.xpsnr.recipe,
        raw: r.prepared.raw,
        statisticsSha256: r.xpsnr.statistics.sha256,
        spatial: (() => {
          const roi = value.result.metric.roi,
            d = value.result.provenance.reference.decoded.description;
          return roi.x ||
            roi.y ||
            roi.width !== d.width ||
            roi.height !== d.height
            ? "cropped-region-temporal-score-not-localized"
            : "full-frame-temporal-score-not-localized";
        })(),
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
    const row = this.db
      .prepare("SELECT body FROM quality_xpsnr_publications WHERE job_id=?")
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
        .prepare("INSERT INTO quality_xpsnr_publications VALUES(?,?)")
        .run(id, JSON.stringify(publication));
      settleScoringReservations(this.db, "xpsnr", id);
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
            id: "xpsnr_" + j.id,
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
          .prepare(
            "UPDATE quality_xpsnr_publications SET body=? WHERE job_id=?",
          )
          .run(JSON.stringify(publication), id);
        settleScoringReservations(this.db, "xpsnr", id);
      }
    }
    return publication;
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      clearTimeout(this.timer);
      this.active?.controller.abort(
        new XpsnrError("cancelled", "XPSNR service stopping"),
      );
      const stop = this.runner.close();
      await this.active?.done;
      await stop;
      await this.ready;
      if (this.fatal) throw this.fatal;
      for (const j of this.all())
        if (!terminalXpsnr(j.state)) {
          j.state = "interrupted";
          j.phase = "done";
          j.endedAt = now();
          j.reason = {
            code: "service-shutdown",
            message: "Service stopped; no automatic retry",
          };
          for (const m of Object.values(j.metrics))
            if (["waiting", "running"].includes(m.state)) {
              m.state = "interrupted";
              m.reason = j.reason;
            }
          this.finish(j, null);
        }
      this.db.close();
      this.unlock();
    })());
  }
}
