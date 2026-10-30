import { normalizeQualityJobInput } from "../../../shared/analysis/quality/job-input.ts";
import { QualityObservationScope } from "./observation-scope.ts";
import {
  FrozenSubmissionJournal,
  assertJobReceipt,
} from "../../services/frozen-submission.ts";
import type {
  QualityJob,
  QualityJobInput,
  QualityJobResult,
} from "../../../shared/analysis/quality/jobs.ts";
import type {
  QualityHistory,
  QualityTransport,
} from "../../services/quality-jobs.ts";
import { randomUUID } from "../../../shared/utils/uuid.ts";

export type PendingQualitySubmission = {
  actor: string;
  client: string;
  key: string;
  input: QualityJobInput;
};
export type QualityObservation = {
  jobs: Omit<QualityJob, "input">[];
  detail: QualityJob | null;
  result: QualityJobResult | null;
  pending: PendingQualitySubmission | null;
  busy: boolean;
  error: unknown | null;
  operationError: unknown | null;
  history: QualityHistory | null;
};
/** Tab-local observation and retry state, never an execution owner. Captured actor
 * and client scopes fence every async publication, including after abort is ignored.
 * A pending request is persisted BEFORE POST; retries never reconstruct its body. */
export class QualityJobObserver {
  private scope = new QualityObservationScope();
  private cursor = 0;
  private submitting: Promise<void> | null = null;
  private selected: string | null = null;
  private jobs = new Map<string, Omit<QualityJob, "input">>();
  private value: QualityObservation = {
    jobs: [],
    detail: null,
    result: null,
    pending: null,
    busy: false,
    error: null,
    operationError: null,
    history: null,
  };
  private transport: QualityTransport;
  readonly actor: string;
  readonly client: string;
  private changed: (value: QualityObservation) => void;
  private journal: FrozenSubmissionJournal<QualityJobInput>;
  constructor(
    transport: QualityTransport,
    actor: string,
    client: string,
    changed: (value: QualityObservation) => void,
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    uuid: () => string = randomUUID,
  ) {
    this.transport = transport;
    this.actor = actor;
    this.client = client;
    this.changed = changed;
    this.journal = new FrozenSubmissionJournal(
      storage,
      () => this.storageKey,
      (value) => {
        const input = value as QualityJobInput;
        if (
          input?.schema !== "voidplayer-psnr-frame-job" ||
          input.client?.id !== this.client
        )
          throw Error("Quality request client scope changed");
        return input;
      },
      {
        read: (value, owner) => {
          const p = value as PendingQualitySubmission & { attempted?: boolean };
          if (p.actor !== owner || p.client !== this.client)
            throw Error("Stored quality scope changed");
          return { body: p.input, key: p.key, attempted: p.attempted };
        },
        write: (p, owner) => ({
          actor: owner,
          client: this.client,
          key: p.key,
          input: p.body,
          attempted: p.attempted,
        }),
      },
      uuid,
    );
    try {
      this.projectPending();
    } catch (error) {
      this.value.operationError = error;
    }
    this.emit();
  }
  private projectPending() {
    const p = this.journal.pending(this.actor);
    this.value.pending = p
      ? { actor: this.actor, client: this.client, key: p.key, input: p.body }
      : null;
  }
  private get storageKey() {
    return `voidplayer-quality-pending:${this.actor}:${this.client}`;
  }
  private emit() {
    this.value.jobs = [...this.jobs.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence,
    );
    this.changed({
      ...this.value,
      pending: this.value.pending ? structuredClone(this.value.pending) : null,
    });
  }
  snapshot() {
    return structuredClone(this.value);
  }
  /** Stop all HTTP observation. No POST cancel and no removal of uncertain submission. */
  dispose() {
    this.scope.close();
  }
  forgetPending() {
    if (this.value.busy) return;
    try {
      this.journal.abandon(this.actor);
      this.value.pending = null;
      this.value.error = null;
      this.value.operationError = null;
    } catch (error) {
      this.value.operationError = error;
    }
    this.emit();
  }
  private accept(job: QualityJob) {
    if (job.submitted.actorId !== this.actor)
      throw new Error("Quality response belongs to another actor");
    const previous = this.jobs.get(job.id);
    if (!previous || job.revision >= previous.revision)
      this.jobs.set(job.id, job);
  }
  submit(input?: QualityJobInput): Promise<void> {
    if (this.submitting) return this.submitting;
    const context = this.scope.capture();
    this.submitting = this.send(input, context).finally(() => {
      this.submitting = null;
    });
    return this.submitting;
  }
  private async send(
    input: QualityJobInput | undefined,
    context: ReturnType<QualityObservationScope["capture"]>,
  ) {
    if (!context.current()) return;
    const actorContext = this.scope.capture("actor");
    this.value.busy = true;
    this.value.operationError = null;
    this.emit();
    try {
      let pending = this.journal.pending(this.actor);
      if (!pending) {
        if (!input) throw Error("Quality input is required");
        pending = this.journal.freeze(this.actor, input);
      }
      this.projectPending();
      this.emit();
      const { job } = await this.journal.execute(
        this.actor,
        pending.key,
        (p) => this.transport.submit(this.actor, p.body, p.key, context.signal),
        (response, p) =>
          assertJobReceipt(
            response,
            this.actor,
            p,
            normalizeQualityJobInput(p.body),
          ),
        false,
        "keep",
      );
      if (!context.current()) return;
      this.scope.select();
      this.accept(job);
      this.value.detail = job;
      this.selected = job.id;
      this.value.result = null;
      this.projectPending();
    } catch (error) {
      if (context.current()) {
        this.value.operationError = error;
        try {
          this.projectPending();
        } catch {}
      }
    } finally {
      if (actorContext.current()) {
        try {
          this.projectPending();
        } catch {}
        this.value.busy = false;
        this.emit();
      }
    }
  }
  resync() {
    this.scope.cancel("history");
    this.scope.select();
    this.cursor = 0;
    this.jobs.clear();
    this.selected = null;
    this.value.detail = null;
    this.value.result = null;
    this.value.error = null;
    this.emit();
    return this.poll();
  }
  poll(): Promise<void> {
    return this.scope.run("history", "actor", async () => {
      const context = this.scope.capture("actor", "history");
      if (!context.current()) return;
      try {
        let pages = 0,
          more = false;
        do {
          const page = await this.transport.changes(
            this.actor,
            this.cursor,
            context.signal,
          );
          if (!context.current()) return;
          for (const job of page.entries) {
            if (job.submitted.actorId !== this.actor)
              throw new Error("Quality history actor scope changed");
            const previous = this.jobs.get(job.id);
            if (!previous || job.revision >= previous.revision)
              this.jobs.set(job.id, job);
          }
          this.cursor = page.cursor;
          more = page.more;
          this.value.history = page;
          this.value.error = null;
          this.emit();
        } while (more && ++pages < 20);
        if (context.current() && this.selected)
          await this.select(this.selected);
      } catch (error) {
        if (context.current()) {
          this.value.error = error;
          this.emit();
        }
      }
    });
  }
  select(id: string): Promise<void> {
    if (this.selected !== id) {
      this.scope.select();
      this.value.detail = null;
      this.value.result = null;
    }
    this.selected = id;
    this.emit();
    return this.scope.run("detail", "selection", async () => {
      const context = this.scope.capture("selection", "detail");
      try {
        const detail = await this.transport.get(this.actor, id, context.signal);
        if (!context.current()) return;
        if (detail.id !== id)
          throw new Error("Quality detail identity mismatch");
        this.accept(detail);
        this.value.detail = detail;
        if (detail.result.available) {
          if (
            this.value.result?.jobId !== id ||
            this.value.result.attemptId !== detail.attempt?.id
          ) {
            const result = await this.transport.result(
              this.actor,
              id,
              context.signal,
            );
            if (!context.current()) return;
            if (
              result.jobId !== detail.id ||
              result.attemptId !== detail.attempt?.id ||
              result.submitted.actorId !== this.actor
            )
              throw new Error("Quality result identity mismatch");
            this.value.result = result;
          }
        } else this.value.result = null;
        this.value.error = null;
        this.emit();
      } catch (error) {
        if (context.current()) {
          this.value.error = error;
          this.emit();
        }
      }
    });
  }
  async cancel(id: string) {
    const context = this.scope.capture("actor");
    try {
      const job = await this.transport.cancel(this.actor, id, context.signal);
      if (!context.current()) return;
      this.accept(job);
      if (this.selected === id) {
        this.scope.select();
        this.value.detail = job;
        this.value.result = null;
      }
      this.value.operationError = null;
      this.emit();
    } catch (error) {
      if (context.current()) {
        this.value.operationError = error;
        this.emit();
      }
    }
  }
}
