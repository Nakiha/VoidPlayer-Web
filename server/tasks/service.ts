import { reexecutionKind } from "../../shared/analysis/quality/reexecution.ts";
import { createHmac, randomBytes } from "node:crypto";
import { AdminError } from "../admin-error.ts";
import type {TaskReadServices,TaskCommands} from "../quality-service-ports.ts";
import { TASK_RETENTION_BATCH } from "./summary.ts";
import {
  TASK_LIMITS,
  TASK_RESULT_KINDS,
  taskPath,
  taskPending,
} from "../../shared/service/tasks.ts";
import type {
  TaskSummary,
  TaskQuery,
  TaskPage,
  TaskKind,
  TaskDetail,
  TaskFilter,
} from "../../shared/service/tasks.ts";

type Snapshot = {
  id: string;
  actor: string;
  filter: TaskFilter;
  capturedAt: number;
  expiresAt: number;
  rows: TaskSummary[];
  bytes: number;
};
/** A bounded read model, not a scheduler. Snapshot pages freeze the complete
 * actor-owned metadata read set. Refresh makes a new read set; no polling work
 * or result pixels are retained by this service. */
export class TaskCenterService {
  private snapshots = new Map<string, Snapshot>();
  private secret = randomBytes(32);
  private services:TaskReadServices;
  private commands:TaskCommands;
  private now: () => number;
  constructor(services:TaskReadServices,commands:TaskCommands, now = Date.now) {
    this.services=services;this.commands=commands;
    this.now = now;
  }
  private owners() {
    const l = this.services;
    return {
      preparation: l.discovery.store,
      correspondence: l.qualityCorrespondence,
      single: l.qualityJobs,
      range: l.qualityRanges,
      vmaf: l.qualityVmaf,
      xpsnr: l.qualityXpsnr,
      cambi: l.qualityCambi,
    };
  }
  private collect(actor: string, filter: TaskFilter = {}): TaskSummary[] {
    if (!this.services.durableQualityJobsEnabled)
      throw new AdminError(
        503,
        "Task history requires persistent storage.",
        "task-storage-unavailable",
      );
    // Synchronous projections freeze one read set. Filter in SQL before the
    // bounded snapshot allocation, including tasks older than the former cap.
    const rows = Object.values(this.owners()).flatMap((owner) =>
      owner.taskSummaries(actor, undefined, filter),
    );
    if (rows.length > TASK_LIMITS.rows)
      throw new AdminError(
        503,
        "Matching history exceeds the snapshot budget. Narrow the filters.",
        "task-snapshot-budget",
      );
    this.rangeRetention(rows, actor);
    return rows;
  }
  private rangeRetention(rows: TaskSummary[], actor: string) {
    const ranges = rows.filter((row) => row.kind === "range" && !row.result.released);
    for (let start = 0; start < ranges.length; start += TASK_RETENTION_BATCH) {
      const batch = ranges.slice(start, start + TASK_RETENTION_BATCH);
      const edges = this.services.qualityRanges.taskChildEdges(
        actor,
        batch.map((row) => row.id),
      );
      const children = this.services.qualityJobs.taskRetainedResults(actor, [
        ...new Set(edges.map((edge) => edge.target)),
      ]);
      const counts = new Map<string, number>();
      for (const edge of edges) {
        const child = children.get(edge.target);
        if (
          child &&
          (!edge.attemptId ||
            (edge.attemptId === child.attemptId &&
              edge.digest === child.resultDigest))
        )
          counts.set(edge.id, (counts.get(edge.id) ?? 0) + 1);
      }
      for (const row of batch) {
        const retained = counts.get(row.id) ?? 0;
        row.result = { ...row.result, available: retained > 0, retained };
        if (!retained)
          row.links = row.links.filter((link) => link.rel !== "result");
      }
    }
  }
  private expired(): never {
    throw new AdminError(
      409,
      "Task cursor expired, changed scope or belongs to another actor. Restart without cursor; keep filters and target.",
      "task-cursor-expired",
    );
  }
  private token(s: Snapshot, offset: number) {
    const text = `${s.id}.${offset}`;
    return `${text}.${createHmac("sha256", this.secret).update(text).digest("hex")}`;
  }
  query(actor: string, query: TaskQuery): TaskPage {
    const now = this.now();
    for (const [id, s] of this.snapshots)
      if (s.expiresAt <= now) this.snapshots.delete(id);
    let snapshot: Snapshot,
      offset = 0;
    if (query.cursor) {
      const [id, n] = query.cursor.split("."),
        s = this.snapshots.get(id);
      offset = Number(n);
      if (
        !s ||
        s.actor !== actor ||
        JSON.stringify(s.filter) !== JSON.stringify(query.filter) ||
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        offset >= s.rows.length ||
        this.token(s, offset) !== query.cursor
      )
        this.expired();
      snapshot = s;
    } else {
      const rows = this.collect(actor, query.filter).sort(
        (a, b) =>
          b.createdAt - a.createdAt ||
          (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      if (bytes > TASK_LIMITS.snapshotBytes)
        throw new AdminError(
          503,
          "Task snapshot exceeds metadata budget. Narrow the query.",
          "task-snapshot-budget",
        );
      const own = [...this.snapshots.values()].filter((s) => s.actor === actor);
      while (own.length >= TASK_LIMITS.actorSnapshots)
        this.snapshots.delete(own.shift()!.id);
      while (
        this.snapshots.size >= TASK_LIMITS.snapshots ||
        [...this.snapshots.values()].reduce((a, s) => a + s.bytes, bytes) >
          TASK_LIMITS.snapshotBytes
      )
        this.snapshots.delete(this.snapshots.keys().next().value!);
      snapshot = {
        id: randomBytes(16).toString("hex"),
        actor,
        filter: query.filter,
        capturedAt: now,
        expiresAt: now + TASK_LIMITS.snapshotMs,
        rows,
        bytes,
      };
      this.snapshots.set(snapshot.id, snapshot);
    }
    const entries = snapshot.rows.slice(offset, offset + query.limit),
      next = offset + entries.length;
    return structuredClone({
      schema: "voidplayer-task-page",
      version: 1,
      filter: snapshot.filter,
      capturedAt: snapshot.capturedAt,
      expiresAt: snapshot.expiresAt,
      entries,
      nextCursor:
        next < snapshot.rows.length ? this.token(snapshot, next) : null,
      total: snapshot.rows.length,
      limits: TASK_LIMITS,
    });
  }
  detail(kind: TaskKind, id: string, actor: string): TaskDetail {
    if (!this.services.durableQualityJobsEnabled)
      throw new AdminError(
        503,
        "Task history requires persistent storage.",
        "task-storage-unavailable",
      );
    const l = this.services,
      owners = this.owners();
    const task = owners[kind].taskSummaries(actor, id)[0];
    const edges = [
      ...l.qualityRanges.taskEdges(actor, id),
      ...l.qualityCorrespondence.taskEdges(actor, id),
      ...l.qualityVmaf.taskEdges(actor, id),
      ...l.qualityXpsnr.taskEdges(actor, id),
    ].filter((e) => {
      const from = owners[e.from].taskSummaries(actor, e.id)[0],
        to = owners[e.to].taskSummaries(actor, e.target)[0];
      return (
        from &&
        to &&
        (!e.attemptId ||
          (e.attemptId === to.attemptId && e.digest === to.resultDigest))
      );
    });
    if (reexecutionKind(kind)) {
      const chain = l.qualityReexecutions.chain(kind, id, actor);
      if (chain.retryOf)
        edges.push({
          from: kind,
          id: chain.retryOf.retryOf,
          to: kind,
          target: id,
          relation: "reexecution",
        });
      if (chain.successor)
        edges.push({
          from: kind,
          id,
          to: kind,
          target: chain.successor.id,
          relation: "reexecution",
        });
    }
    if (!task)
      throw new AdminError(
        404,
        "Task not found for this actor.",
        "task-not-found",
      );
    this.rangeRetention([task], actor);
    const related: TaskDetail["related"] = [];
    for (const e of edges) {
      if (
        !(
          (e.from === kind && e.id === id) ||
          (e.to === kind && e.target === id)
        )
      )
        continue;
      // Listing projects only metadata. Detail verifies the original frozen
      // receipt/input association before presenting an actionable link.
      if (e.relation === "reexecution") {
        if (
          e.from !== e.to ||
          !reexecutionKind(e.from) ||
          this.services.qualityReexecutions.chain(e.from, e.id, actor).successor
            ?.id !== e.target
        )
          continue;
      } else {
        if (
          e.from === "correspondence" &&
          this.services.qualityCorrespondence.taskRange(e.id, actor) !== e.target
        )
          continue;
        if (
          e.from === "range" &&
          !this.services.qualityRanges.taskChild(e.id, e.target, actor)
        )
          continue;
        if (e.from === "vmaf" || e.from === "xpsnr") {
          const pin = (
              e.from === "vmaf"
                ? this.services.qualityVmaf
                : this.services.qualityXpsnr
            ).get(e.id, actor).input.plan,
            plan = this.services.qualityCorrespondence.get(e.target, actor);
          if (
            pin.id !== plan.id ||
            pin.attemptId !== plan.attemptId ||
            pin.digest !== plan.resultDigest
          )
            continue;
        }
      }
      if (e.from === kind && e.id === id)
        related.push({
          kind: e.to,
          id: e.target,
          relation: e.relation,
          href: taskPath(e.to, e.target),
        });
      if (e.to === kind && e.target === id)
        related.push({
          kind: e.from,
          id: e.id,
          relation: `parent-${e.relation}`,
          href: taskPath(e.from, e.id),
        });
    }
    const links = [...task.links];
    if (kind === "correspondence") {
      const plan = this.services.qualityCorrespondence.get(id, actor),
        relation = this.services.qualityCorrespondence.relation(
          plan.relation.id,
          actor,
        );
      if (JSON.stringify(relation) === JSON.stringify(plan.relation))
        links.push({
          rel: "reference-relation",
          href: `/api/quality/reference-relations/${encodeURIComponent(relation.id)}`,
        });
    }
    if (
      kind === "range" ||
      kind === "vmaf" ||
      kind === "xpsnr" ||
      kind === "cambi"
    )
      links.push({
        rel: "candidate-receipt",
        href: task.links[0].href + "/candidates",
      });
    if (reexecutionKind(kind)) {
      links.push({
        rel: "reexecution-chain",
        href: task.links[0].href + "/reexecutions",
      });
      if (
        ["failed", "interrupted", "cancelled", "partial"].includes(task.state)
      )
        links.push({
          rel: "reexecution-plan",
          href: task.links[0].href + "/reexecution-plan",
        });
    }
    if (
      TASK_RESULT_KINDS.includes(kind) &&
      !taskPending(task.state) &&
      (task.result.available || task.result.releasePending)
    )
      links.push({
        rel: "release-result",
        href: taskPath(kind, id) + "/release-result",
      });
    if (taskPending(task.state))
      links.push({ rel: "cancel", href: taskPath(kind, id) + "/cancel" });
    return {
      schema: "voidplayer-task-detail",
      version: 1,
      task,
      related,
      links,
    };
  }
  cancel(kind: TaskKind, id: string, actor: string, requestId: string) {
    // Resolve actor ownership before delegating. Original services remain the
    // authority for idempotent cancellation and confirmed physical exit.
    this.detail(kind, id, actor);
    this.commands[kind](id,actor,requestId);
    return this.detail(kind, id, actor);
  }
  close() {
    this.snapshots.clear();
  }
}
