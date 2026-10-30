import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { openIndexDatabase } from "../../sqlite.ts";
import { lockDatabase } from "../../library-store.ts";
import { AdminError } from "../../admin-error.ts";
import type { Actor } from "../../identity.ts";
import { closeResources } from "../../shutdown.ts";
import { taskSummaries, taskEdges } from "../../tasks/summary.ts";
import { ReexecutionLedger } from "./reexecution-ledger.ts";
import type { ReexecutionCreation } from "./reexecution-ledger.ts";
import type { ReexecutionRequest } from "../../../shared/analysis/quality/reexecution.ts";
import { qualityIdempotencyKey } from "./job-request.ts";
import {
  reserveScoringBytes,
  settleScoringReservations,
  releaseScoringResult,
} from "./result-retention.ts";
import { stopOwnedNative } from "./legacy-process.ts";
import type { CorrespondenceService } from "./correspondence-service.ts";
import {
  canonicalJson,
  VMAF_LIMITS,
} from "../../../shared/analysis/quality/vmaf.ts";
import type {
  VmafInput,
  VmafJob,
  VmafMetricState,
  VmafPlanSnapshot,
  VmafPrepared,
} from "../../../shared/analysis/quality/vmaf.ts";
import type { XpsnrInput } from "../../../shared/analysis/quality/xpsnr.ts";

export const scoringDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const scoringNow = () =>
  Math.floor(performance.timeOrigin + performance.now());
const digest = scoringDigest,
  now = scoringNow,
  waiting = () => ({ state: "waiting" as const, reason: null });
type Kind = "vmaf" | "xpsnr";
type Input = VmafInput | XpsnrInput;
export type TemporalJob<K extends Kind, I extends Input> = Omit<
  VmafJob,
  "schema" | "input" | "metrics"
> & {
  schema: `voidplayer-native-${K}-job-state`;
  input: I;
  metrics: { psnr: VmafMetricState; ssim: VmafMetricState } & Record<
    K,
    VmafMetricState
  >;
};
interface Executor {
  readonly admission?: import('../../quality-admission.ts').QualityAdmission;
  readonly stopUncertain: boolean;
  readonly ready?: Promise<void>;
  assertAvailable(): void;
  close(): Promise<void>;
}

/** Shared durable ownership, not a numerical metric. Domain subclasses retain
 * input parsing, preparation validation, execution, pooling, evidence and policy.
 * The original tables/wire names, transactions and receipts stay unchanged. */
export abstract class TemporalScoringService<K extends Kind, I extends Input> {
  readonly reexecutions: ReexecutionLedger;
  protected db: ReturnType<typeof openIndexDatabase>;
  protected unlock: () => void;
  readonly ready: Promise<void>;
  protected recovered = false;
  protected closed = false;
  protected fatal: unknown;
  protected active = new Map<string,{
    id: string;
    controller: AbortController;
    done: Promise<void>;
  }>();
  private unqueue?:()=>void;
  protected timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  protected file: string;
  protected executor: Executor;
  protected plans: CorrespondenceService;
  protected kind: K;
  protected limits: typeof VMAF_LIMITS;
  protected get label() {
    return this.kind.toUpperCase();
  }
  protected terminal(state: TemporalJob<K, I>["state"]) {
    return !["queued", "preparing", "running", "cancelling"].includes(state);
  }
  protected abstract parse(value: unknown): I;
  protected abstract execute(id: string, signal: AbortSignal): Promise<void>;
  protected abstract finish(job: TemporalJob<K, I>, native: null): void;
  protected abstract metricError(code: string, message: string): Error;
  protected constructor(
    file: string,
    executor: Executor,
    plans: CorrespondenceService,
    kind: K,
    limits: typeof VMAF_LIMITS,
  ) {
    this.file = file;
    this.executor = executor;
    this.plans = plans;
    this.kind = kind;
    this.limits = limits;
    mkdirSync(path.dirname(file), { recursive: true });
    this.unlock = lockDatabase(file);
    let db: ReturnType<typeof openIndexDatabase> | undefined;
    try {
      this.db = db = openIndexDatabase(file);
      db.exec("PRAGMA busy_timeout=0;");
      if (Number(db.prepare("PRAGMA user_version").get()!.user_version) > 2)
        throw new AdminError(
          409,
          `${this.label} history requires a newer application.`,
          `future-${kind}-schema`,
        );
      db.exec(
        `PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;CREATE TABLE IF NOT EXISTS quality_${kind}_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,snapshot TEXT NOT NULL,prepared TEXT,result TEXT,reserved INTEGER NOT NULL,UNIQUE(actor,client,key));CREATE TABLE IF NOT EXISTS quality_${kind}_publications(job_id TEXT PRIMARY KEY,body TEXT NOT NULL);`,
      );
      this.reexecutions = new ReexecutionLedger(db);
      db.exec("PRAGMA user_version=2;COMMIT;");
    } catch (error) {
      const failures = [error];
      try {
        db?.close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.unlock();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Scoring storage initialization failed",
          { cause: error },
        );
      throw error;
    }
    this.unqueue=executor.admission?.registerQueue(()=>this.all().map(j=>({actor:j.actor.id,count:1})));
    this.ready = this.recover();
    void this.ready.catch((error) => {
      this.fatal = error;
    });
  }
  taskSummaries(
    actor: string,
    id?: string,
    filter?: import("../../../shared/service/tasks.ts").TaskFilter,
  ) {
    return taskSummaries(this.db, this.kind, actor, id, filter);
  }
  taskEdges(actor: string, id?: string) {
    return taskEdges(this.db, this.kind, actor, id);
  }
  protected async recover() {
    await this.executor.ready;
    for (const job of this.all())
      if (!this.terminal(job.state)) {
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
    const suffix = `.quality-${this.kind}.sqlite`;
    if (this.file.endsWith(suffix))
      rmSync(this.file.slice(0, -suffix.length) + `.${this.kind}-tmp`, {
        recursive: true,
        force: true,
      });
    this.recovered = true;
  }
  protected available() {
    if (
      this.closed ||
      this.fatal ||
      !this.recovered ||
      this.executor.stopUncertain
    )
      throw new AdminError(
        503,
        `${this.label} service unavailable or recovering.`,
        `${this.kind}-service-unavailable`,
      );
  }
  protected all() {
    return this.db
      .prepare(
        `SELECT body FROM quality_${this.kind}_jobs WHERE json_extract(body,'$.state') IN ('queued','preparing','running','cancelling') ORDER BY rowid`,
      )
      .all()
      .map((r) => JSON.parse(String(r.body)) as TemporalJob<K, I>);
  }
  protected save(job: TemporalJob<K, I>) {
    job.revision++;
    this.db
      .prepare(`UPDATE quality_${this.kind}_jobs SET body=? WHERE id=?`)
      .run(JSON.stringify(job), job.id);
    if (this.terminal(job.state))
      settleScoringReservations(this.db, this.kind, job.id);
  }
  protected blocked(job:TemporalJob<K,I>,error:AdminError){
    if(job.reason?.message!==error.message){job.reason={code:error.code,message:error.message.slice(0,300)};this.save(job);}
  }
  get(id: string, actor: string) {
    const row = this.db
      .prepare(
        `SELECT body,fingerprint,result IS NOT NULL AS retained FROM quality_${this.kind}_jobs WHERE id=? AND actor=?`,
      )
      .get(id, actor);
    if (!row)
      throw new AdminError(
        404,
        `${this.label} job not found.`,
        `${this.kind}-not-found`,
      );
    const job = JSON.parse(String(row.body)) as TemporalJob<K, I>;
    if (digest(job.input) !== row.fingerprint)
      throw new AdminError(
        500,
        `Stored ${this.label} request changed.`,
        `stored-${this.kind}-invalid`,
      );
    return {...job, resultRetained: !!row.retained};
  }
  history(actor: string, after = 0, limit = 8) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 16
    )
      throw new AdminError(
        400,
        `Invalid ${this.label} cursor.`,
        "invalid-cursor",
      );
    const rows = this.db
      .prepare(
        `SELECT rowid,body,result IS NOT NULL AS retained FROM quality_${this.kind}_jobs WHERE actor=? AND rowid>? ORDER BY rowid LIMIT ?`,
      )
      .all(actor, after, limit + 1);
    return {
      entries: rows.slice(0, limit).map((r) => ({...JSON.parse(String(r.body)),resultRetained:!!r.retained})),
      after: rows.length
        ? Number(rows[Math.min(limit, rows.length) - 1].rowid)
        : after,
      more: rows.length > limit,
    };
  }
  protected snapshot(input: I, actor: string): VmafPlanSnapshot {
    const plan = this.plans.get(input.plan.id, actor);
    if (
      plan.state !== "completed" ||
      plan.attemptId !== input.plan.attemptId ||
      plan.resultDigest !== input.plan.digest
    )
      throw new AdminError(
        409,
        "Pin a completed correspondence attempt/digest.",
        `${this.kind}-plan-changed`,
      );
    return { ...input.plan, value: this.plans.result(plan.id, actor) };
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
    let accepted: { job: TemporalJob<K, I>; replayed: boolean };
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
            `SELECT id,fingerprint FROM quality_${this.kind}_jobs WHERE actor=? AND client=? AND key=?`,
          )
          .get(actor.id, input.client.id, k);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AdminError(
              409,
              `${this.label} key binds a different recipe.`,
              "idempotency-conflict",
            );
          return { job: this.get(String(prior.id), actor.id), replayed: true };
        }
        this.executor.assertAvailable();
        this.executor.admission?.assertQueue(actor.id);
        const snapshot = this.snapshot(input, actor.id),
          all = this.all(),
          live = all.filter((j) => !this.terminal(j.state));
        if (
          live.length >= this.limits.queued ||
          live.filter((j) => j.actor.id === actor.id).length >=
            this.limits.actorOutstanding
        )
          throw new AdminError(
            429,
            `${this.label} bounded queue is full.`,
            `${this.kind}-queue-full`,
          );
        settleScoringReservations(this.db, this.kind);
        const reserved = reserveScoringBytes(
            this.limits.resultBytes,
            input,
            snapshot,
          ),
          used = Number(
            this.db
              .prepare(
                `SELECT coalesce(sum(reserved),0) AS n FROM quality_${this.kind}_jobs`,
              )
              .get()!.n,
          );
        if (used + reserved > this.limits.reservedBytes)
          throw new AdminError(
            429,
            `${this.label} history budget is full; old receipts retained.`,
            `${this.kind}-history-full`,
          );
        const createdAt = now(),
          job: TemporalJob<K, I> = {
            ...(reexecution
              ? {
                  executionContract: reexecution.contract,
                  retryOf: reexecution.lineage,
                }
              : {}),
            schema: `voidplayer-native-${this.kind}-job-state`,
            version: 1,
            id: `${this.kind}-` + randomUUID(),
            actor: { id: actor.id, name: actor.name },
            key: k,
            requestId,
            input,
            revision: 1,
            createdAt,
            queueUntil: createdAt + this.limits.queueWaitMs,
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
              [this.kind]: waiting(),
            } as TemporalJob<K, I>["metrics"],
            resultDigest: null,
            process: null,
          };
        this.db
          .prepare(
            `INSERT INTO quality_${this.kind}_jobs VALUES(?,?,?,?,?,?,?,NULL,NULL,?)`,
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
            .prepare(
              `SELECT snapshot FROM quality_${this.kind}_jobs WHERE id=?`,
            )
            .get(id)!.snapshot,
        ),
      ) as VmafPlanSnapshot;
    if (
      snapshot.id !== job.input.plan.id ||
      snapshot.attemptId !== job.input.plan.attemptId ||
      snapshot.digest !== job.input.plan.digest ||
      digest(snapshot.value) !== snapshot.digest
    )
      throw new AdminError(
        409,
        `Frozen ${this.label} C plan snapshot changed.`,
        "stored-input-invalid",
      );
    return snapshot;
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
  protected wake() {
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
  protected pump() {
    if (this.closed || this.fatal || !this.recovered) return;
    for (const j of this.all().filter(
      (j) => j.state === "queued" && j.queueUntil <= now(),
    )) {
      j.reason = {
        code: "queue-expired",
        message: `${this.label} queue deadline exceeded before execution`,
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
    while(this.active.size<(this.executor.admission?.capacity(this.kind)??1)){
    const job = this.all().find((j) => j.state === "queued"&&!this.active.has(j.id));
    if (!job) break;
    const active = {
      id: job.id,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(job.id,active);
    active.done = this.execute(job.id, active.controller.signal)
      .catch((error) => {
        this.fatal = error;
        console.error(
          `${this.label} service stopped; durable history retained.`,
        );
      })
      .finally(() => {
        this.active.delete(job.id);
        this.wake();
      });
    }
    this.wake();
  }
  protected prepared(id: string) {
    const row = this.db
      .prepare(`SELECT prepared FROM quality_${this.kind}_jobs WHERE id=?`)
      .get(id);
    return row?.prepared
      ? (JSON.parse(String(row.prepared)) as VmafPrepared)
      : null;
  }
  releaseResult(id: string, actor: string) {
    this.available();
    const j = this.get(id, actor);
    if (!this.terminal(j.state) || j.process || this.active.has(id))
      throw new AdminError(
        409,
        "Wait for physical task completion before releasing results.",
        "result-still-running",
      );
    if (
      this.db
        .prepare(
          `SELECT 1 FROM quality_${this.kind}_publications WHERE job_id=?`,
        )
        .get(id)
    )
      throw new AdminError(
        409,
        "A frozen publication retains this result.",
        "result-publication-pinned",
      );
    releaseScoringResult(this.db, this.kind, id);
    return { jobId: id, released: true, receiptRetained: true };
  }
  cancel(id: string, actor: string) {
    this.available();
    const j = this.get(id, actor);
    if (this.terminal(j.state)) return j;
    if (j.state === "queued") {
        this.active.get(id)?.controller.abort(
          this.metricError(
            "cancelled",
            `${this.label} cancelled before admission`,
          ),
        );
      j.state = "cancelled";
      j.phase = "done";
      j.endedAt = now();
      j.reason = {
        code: "cancelled",
        message: `${this.label} cancelled before execution`,
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
        this.active.get(id)?.controller.abort(
          this.metricError("cancelled", `${this.label} explicitly cancelled`),
        );
    }
    return this.get(id, actor);
  }
  private stopping?: Promise<void>;
  stopExecution() {
    return (this.stopping ??= (async () => {
      this.closed = true;
      clearTimeout(this.timer);
      for(const active of this.active.values())active.controller.abort(
        this.metricError("cancelled", `${this.label} service stopping`),
      );
      await closeResources(`${this.label} physical shutdown incomplete`, [
        ["executor", () => this.executor.close()],
        ["active attempts", () => Promise.all([...this.active.values()].map(a=>a.done))],
        ["recovery", () => this.ready],
      ]);
      if (this.fatal) throw this.fatal;
      for (const job of this.all())
        if (!this.terminal(job.state)) {
          job.state = "interrupted";
          job.phase = "done";
          job.endedAt = now();
          job.reason = {
            code: "service-shutdown",
            message: "Service stopped; no automatic retry",
          };
          for (const metric of Object.values(job.metrics) as VmafMetricState[])
            if (["waiting", "running"].includes(metric.state)) {
              metric.state = "interrupted";
              metric.reason = job.reason;
            }
          this.finish(job, null);
        }

    })());
  }
  close() { return this.closing ??= this.stopExecution().then(()=>{this.unqueue?.();this.db.close();this.unlock();}); }

}
