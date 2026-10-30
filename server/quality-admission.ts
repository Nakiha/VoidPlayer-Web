import { AdminError } from "./admin-error.ts";
import {
  DEFAULT_QUALITY_RESOURCES,
  QUALITY_EXECUTORS,
  qualityResourceLimits,
} from "../shared/service/quality-resources.ts";
import type {
  QualityExecutor,
  QualityReservation,
  QualityResourceLimits,
  QualityResourceStatus,
  QualityQueueCount,
} from "../shared/service/quality-resources.ts";

/** Conservative instance-wide exclusion for one-shot quality versus index
 * builds/uploads and bitstream work. Existing read-only cache queries remain usable.
 * This bounds those admitted workers; it is not a process RSS or OS CPU quota. */
export class QualityAdmission {
  private limits = structuredClone(DEFAULT_QUALITY_RESOURCES);
  private active = new Set<QualityReservation | null>();
  private exclusive = new Set<QualityReservation | null>();
  private blockers = new Set<() => boolean>();
  private queues = new Set<() => QualityQueueCount[]>();
  configure(value: QualityResourceLimits) {
    this.limits = qualityResourceLimits(value);
  }
  capacity(kind: QualityExecutor) {
    return Math.min(this.limits.concurrency, this.limits.perExecutor[kind]);
  }
  registerQueue(read: () => QualityQueueCount[]) {
    this.queues.add(read);
    return () => this.queues.delete(read);
  }
  assertQueue(actor: string) {
    const rows = [...this.queues].flatMap((read) => read());
    if (rows.reduce((n, row) => n + row.count, 0) >= this.limits.outstanding)
      throw new AdminError(
        429,
        "Instance quality queue is full.",
        "quality-global-queue-full",
      );
    if (
      rows
        .filter((row) => row.actor === actor)
        .reduce((n, row) => n + row.count, 0) >= this.limits.actorOutstanding
    )
      throw new AdminError(
        429,
        "Actor quality queue is full across executors.",
        "quality-global-actor-limit",
      );
  }
  resources(): QualityResourceStatus {
    const rows = [...this.active].filter(
      (r): r is QualityReservation => r !== null,
    );
    return {
      limits: structuredClone(this.limits),
      running: this.active.size,
      outstanding: [...this.queues]
        .flatMap((read) => read())
        .reduce((n, row) => n + row.count, 0),
      reservations: rows.reduce(
        (a, r) => ({
          memoryBytes: a.memoryBytes + r.memoryBytes,
          readBytes: a.readBytes + r.readBytes,
          threads: a.threads + r.threads,
        }),
        { memoryBytes: 0, readBytes: 0, threads: 0 },
      ),
      executors: Object.fromEntries(
        QUALITY_EXECUTORS.map((kind) => [
          kind,
          {
            running: rows.filter((r) => r.executor === kind).length,
            limit: this.capacity(kind),
          },
        ]),
      ) as QualityResourceStatus["executors"],
      ordinaryPolicy: "exclusive-with-index-and-bitstream",
      exclusiveOwner: this.exclusive.size > 0,
    };
  }
  register(blocked: () => boolean) {
    this.blockers.add(blocked);
    return () => this.blockers.delete(blocked);
  }
  ordinary() {
    if (this.active.size)
      throw new AdminError(
        503,
        "Quality execution owns the compute admission.",
        "quality-busy",
      );
  }
  private busy(resource: string): never {
    throw new AdminError(
      503,
      `Waiting for compute admission: ${resource}.`,
      "quality-busy",
      { resource },
    );
  }
  /** No-argument legacy callers request exclusive inspection, never a free slot. */
  acquire(
    reservation: QualityReservation | null = null,
    exclusive = reservation === null,
  ) {
    if (reservation) {
      if (
        !QUALITY_EXECUTORS.includes(reservation.executor) ||
        !["memoryBytes", "readBytes", "threads"].every(
          (k) =>
            Number.isSafeInteger(reservation[k as keyof QualityReservation]) &&
            Number(reservation[k as keyof QualityReservation]) > 0,
        )
      )
        throw new AdminError(
          400,
          "Invalid compute reservation.",
          "invalid-resource-reservation",
        );
      if (
        reservation.memoryBytes > this.limits.memoryBytes ||
        reservation.readBytes > this.limits.readBytes ||
        reservation.threads > this.limits.threads
      )
        throw new AdminError(
          413,
          "Execution reservation exceeds instance resource limits.",
          "quality-resource-limit",
        );
    }
    const status = this.resources(),
      used = status.reservations;
    if ([...this.blockers].some((blocked) => blocked()))
      this.busy("index-or-bitstream");
    if (this.exclusive.size > 0 || (exclusive && this.active.size > 0))
      this.busy("exclusive-owner");
    if (reservation) {
      if (this.active.size >= this.limits.concurrency)
        this.busy("total-concurrency");
      if (
        status.executors[reservation.executor].running >=
        this.capacity(reservation.executor)
      )
        this.busy(`executor-${reservation.executor}`);
      if (used.memoryBytes + reservation.memoryBytes > this.limits.memoryBytes)
        this.busy("memory-reservation");
      if (used.readBytes + reservation.readBytes > this.limits.readBytes)
        this.busy("read-reservation");
      if (used.threads + reservation.threads > this.limits.threads)
        this.busy("internal-threads");
    }
    const owned = reservation ? structuredClone(reservation) : null;
    this.active.add(owned);
    if (exclusive) this.exclusive.add(owned);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active.delete(owned);
        this.exclusive.delete(owned);
      }
    };
  }
}
