import { DEFAULT_ANALYSIS_CONCURRENCY, validAnalysisConcurrency, ANALYSIS_WORKER_HEAP_BYTES } from './limits.ts';
import { Worker } from "node:worker_threads";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
  BUDGET,
  validateResult,
  validateTarget,
  validateRange,
  validateStream,
  pictureId,
} from "../../src/bitstream-analysis/contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
} from "../../src/bitstream-analysis/contract.ts";
import { libraryAnalysisIndex } from "./index.ts";
import { AnalysisStore } from "./store.ts";
import {
  AnalysisFailure,
  failureInfo,
  restoreFailure,
} from "../../src/bitstream-analysis/failure.ts";
import type { AnalysisFailureInfo } from "../../src/bitstream-analysis/failure.ts";
import type { MediaLibraryIndex } from "../library.ts";
declare const VOIDPLAYER_COMPILED: boolean;
import type { StreamChunkRef } from './store.ts';
import type { StreamProgress } from '../../src/bitstream-analysis/stream.ts';
type Work = {
  published: number;
  pending: StreamChunkRef[];
  page: StreamChunkRef[];
  progress?: StreamProgress;
  wake?: () => void;
  writing?: Set<string>;
  done?: Promise<void>;
  id: string;
  mediaId: string;
  version: string;
  filePath: string;
  target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget;
  chunks: string[];
  buildId: string;
  state:
    | "queued"
    | "running"
    | "complete"
    | "unsupported"
    | "limited"
    | "error"
    | "cancelled";
  error?: string;
  reason?: AnalysisFailureInfo;
  unsupportedResult?: AnalysisResult;
  consumers: Set<string>;
  worker?: Worker;
  seq: number;
};
type Consumer = { work: Work; owner: string; expires: number; cursor: number; delivered: number };
// Reserve capacity before constructing a worker, including index-waiting and
// consumer-backpressured jobs. Per-window admission cannot bound a shared server.
/** Bounded independent jobs; matching demands share work and consumer leases. */
export class AnalysisScheduler {
  private work = new Map<string, Work>();
  private consumers = new Map<string, Consumer>();
  private running = new Set<Work>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private concurrency = DEFAULT_ANALYSIS_CONCURRENCY;
  setConcurrency(value: number) {
    if (!validAnalysisConcurrency(value)) throw new RangeError("Invalid analysis concurrency");
    this.concurrency = value;
    // Reductions only affect future admission; existing workers keep their slots.
    this.pump();
  }
  resources() {
    return { concurrency: this.concurrency, running: this.running.size, queued: [...this.work.values()].filter(work => work.state === "queued").length };
  }
  private pendingSubmissions = 0;
  private resultReads = 0;
  private waitingReads: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  /** Bound transport buffers separately from worker concurrency. Busy readers
   * wait instead of failing an otherwise healthy parallel analysis. */
  waitForResultRead(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new AnalysisFailure('cancelled', 'Analysis service closed'));
    const release = this.reserveResultRead();
    if (release) return Promise.resolve(release);
    if (this.waitingReads.length >= BUDGET.requests) return Promise.reject(new AnalysisFailure('resource-limit', 'Analysis result transport queue full'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        this.waitingReads = this.waitingReads.filter(item => item !== entry); reject(signal.reason);
      } };
      signal.addEventListener('abort', entry.abort, { once: true }); this.waitingReads.push(entry);
    });
  }
  private pumpReads() {
    while (!this.closed && this.waitingReads.length && this.resultReads < 2) {
      const entry = this.waitingReads.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      entry.resolve(this.reserveResultRead()!);
    }
  }
  reserveResultRead() {
    if (this.resultReads >= 2) return null;
    this.resultReads++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.resultReads--; this.pumpReads();
      }
    };
  }
  private submissions: Promise<unknown> = Promise.resolve();
  readonly store: AnalysisStore;
  private library: MediaLibraryIndex;
  private coreDir: string;
  private now: () => number;
  private leaseMs: number;
  constructor(
    library: MediaLibraryIndex,
    coreDir: string,
    directory: string,
    now = () => Date.now(),
    leaseMs: number = BUDGET.leaseMs,
  ) {
    this.library = library;
    this.coreDir = coreDir;
    this.now = now;
    this.leaseMs = leaseMs;
    this.store = new AnalysisStore(directory, undefined, () => this.protectedFiles());
  }
  submit(
    mediaId: string,
    version: string,
    target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget,
    owner: string,
  ) {
    if (this.closed || this.pendingSubmissions >= BUDGET.requests)
      return Promise.reject(
        new AnalysisFailure("resource-limit", "Analysis request queue full"),
      );
    this.pendingSubmissions++;
    const task = this.submissions
      .then(() => this.submitInner(mediaId, version, target, owner))
      .finally(() => {
        this.pendingSubmissions--;
      });
    this.submissions = task.catch(() => {});
    return task;
  }
  private async submitInner(
    mediaId: string,
    version: string,
    target: AnalysisTarget | AnalysisRangeTarget | AnalysisStreamTarget,
    owner: string,
  ) {
    if (this.closed) throw new Error("Analysis service closed");
    if (!target || typeof target !== "object") throw new AnalysisFailure("invalid-request", "Invalid analysis target");
    if ("mode" in target) validateStream(target);
    else if ("startUs" in target) validateRange(target);
    else validateTarget(target);
    if (target.sourceVersion !== `${mediaId}@${version}`)
      throw new AnalysisFailure(
        "source-changed",
        "Analysis source version mismatch",
      );
    if (this.consumers.size >= BUDGET.requests)
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis request queue full",
      );
    const filePath = await this.library.resolve(mediaId, version);
    if (!filePath)
      throw new AnalysisFailure(
        "source-changed",
        "Analysis media version changed",
      );
    const manifest = JSON.parse(
      await readFile(path.join(this.coreDir, "manifest.json"), "utf8"),
    );
    if (manifest.abi !== 1 || manifest.semanticVersion !== ANALYZER_VERSION)
      throw new Error("Analysis core ABI/version mismatch");
    if (!Number.isSafeInteger(manifest.heapMaxBytes) || manifest.heapMaxBytes <= 0 ||
        manifest.heapMaxBytes > ANALYSIS_WORKER_HEAP_BYTES)
      throw new AnalysisFailure('resource-limit', 'Analysis core exceeds server heap reservation');
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          target.sourceVersion,
          "mode" in target ? ['stream', target.firstPtsUs, target.durationUs] : "startUs" in target
            ? [target.firstPtsUs, target.startUs, target.endUs]
            : target.picture
              ? pictureId(target.picture)
              : target.sourcePtsUs,
          ANALYSIS_RECIPE,
          ANALYZER_VERSION,
          (manifest.buildId ?? manifest.revision),
        ]),
      )
      .digest("hex");
    let work = this.work.get(id);
    if (work?.state === "complete") {
      let valid = true;
      for (const chunk of work.chunks)
        if (!(await this.store.get(chunk))) {
          valid = false;
          break;
        }
      if (!valid) {
        work.state = "error";
        work.error = "Analysis cache evicted";
        work.seq++;
        this.work.delete(id);
        work = undefined;
      }
    }
    if (
      !work ||
      ["cancelled", "error", "unsupported", "limited"].includes(work.state)
    ) {
      const chunks = "startUs" in target ? await this.store.manifest(id) : null;
      const cached = "startUs" in target || "mode" in target ? null : await this.store.get(id);
      if (
        cached &&
        (cached.buildId !== (manifest.buildId ?? manifest.revision) ||
          cached.picture.sourceVersion !== target.sourceVersion)
      )
        throw new Error("Invalid analysis cache identity");
      work = {
        published: 0, pending: [], page: [],
        id,
        mediaId,
        version,
        filePath,
        target,
        chunks: chunks ?? (cached ? [id] : []),
        buildId: (manifest.buildId ?? manifest.revision),
        state: cached || chunks ? "complete" : "queued",
        consumers: new Set(),
        seq: 0,
      };
      this.work.set(id, work);
    }
    if (this.closed) throw new Error("Analysis service closed");
    const requestId = randomUUID();
    work.consumers.add(requestId);
    this.consumers.set(requestId, {
      work,
      owner, cursor: 0, delivered: 0,
      expires: this.now() + this.leaseMs,
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.expire(), 1000);
      this.timer.unref();
    }
    void this.pump();
    return {
      requestId,
      state: work.state,
      leaseMs: this.leaseMs,
      cacheHit: work.state === "complete",
    };
  }
  status(id: string, owner: string) {
    const consumer = this.consumers.get(id);
    if (!consumer || consumer.owner !== owner || consumer.expires <= this.now())
      return null;
    consumer.expires = this.now() + this.leaseMs;
    const w = consumer.work;
    return {
      state: w.state,
      seq: w.seq,
      error: w.error,
      reason: w.reason,
      ...(w.unsupportedResult ? { result: w.unsupportedResult } : {}),
      leaseMs: this.leaseMs,
      ...('mode' in w.target ? { published: w.published, progress: w.progress } : {}),
      chunks: w.chunks.map((id) => ({
        id,
        url: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${id}?v=${w.version}`,
      })),
      ...(!("startUs" in w.target) && !("mode" in w.target) && w.state === "complete"
        ? {
            resultUrl: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${w.id}?v=${w.version}`,
          }
        : {}),
    };
  }
  /** Cursor acknowledges only previously delivered descriptors. The worker
   * stalls at 32 unconsumed chunks; leases release disconnected consumers. */
  async streamStatus(id: string, owner: string, after: number) {
    const status = this.status(id, owner), c = this.consumers.get(id);
    if (!status || !c) return null;
    if (!('mode' in c.work.target)) throw new AnalysisFailure('invalid-request', 'Cursor requires a stream request');
    if (!Number.isSafeInteger(after) || after < c.cursor || after > c.delivered)
      throw new AnalysisFailure('invalid-request', 'Invalid stream acknowledgement');
    c.cursor = after;
    const w = c.work;
    this.advance(w);
    const refs: StreamChunkRef[] = [];
    let cursor = after;
    while (cursor < w.published && refs.length < 32) {
      const page = await this.store.streamPage(w.id, Math.floor(cursor / 32));
      const remaining = page.slice(cursor % 32, cursor % 32 + 32 - refs.length);
      if (!remaining.length) throw new Error('Incomplete stream page');
      refs.push(...remaining); cursor += remaining.length;
    }
    c.delivered = Math.max(c.delivered, cursor);
    return { ...status, chunks: refs.map(ref => ({ ...ref,
      url: `/api/media/${w.mediaId}/bitstream-analysis/chunks/${ref.id}?v=${w.version}` })) };
  }
  private advance(w: Work) {
    if (!('mode' in w.target)) return;
    const acknowledged = Math.min(...[...w.consumers].map(id => this.consumers.get(id)?.cursor ?? w.published));
    while (w.pending.length && w.pending[0].cursor <= acknowledged) w.pending.shift();
    if (w.pending.length < 32) { const wake = w.wake; w.wake = undefined; wake?.(); }
  }
  private protectedFiles() {
    const files = new Set<string>();
    // All unread chunks and in-flight commits must survive writes by other jobs.
    for (const w of this.work.values()) {
      for (const file of w.writing ?? []) files.add(file);
      if (!w.consumers.size) continue;
      for (const ref of w.pending) {
        files.add(this.store.chunkFile(ref.id));
        files.add(this.store.streamPageFile(w.id, Math.floor((ref.cursor - 1) / 32)));
      }
      for (const chunk of w.chunks) files.add(this.store.chunkFile(chunk));
    }
    return files;
  }
  release(id: string, owner?: string) {
    const c = this.consumers.get(id);
    if (!c || (owner !== undefined && c.owner !== owner)) return false;
    this.consumers.delete(id);
    c.work.consumers.delete(id);
    this.advance(c.work);
    if (!c.work.consumers.size) {
      if (c.work.state === "queued" || c.work.state === "running") {
        c.work.state = "cancelled";
        c.work.seq++;
        void c.work.worker?.terminate();
      }
      if (this.work.get(c.work.id) === c.work) this.work.delete(c.work.id);
    }
    return true;
  }
  expire() {
    for (const [id, c] of this.consumers)
      if (c.expires <= this.now()) this.release(id);
  }
  private pump() {
    if (this.closed) return;
    // Prioritize paused-picture demand over queued ranges/streams. Running work
    // retains its decoder; a slot is released only after worker termination.
    const queued = [...this.work.values()].filter(w => w.state === 'queued' && w.consumers.size);
    queued.sort((a, b) => Number('mode' in a.target || 'startUs' in a.target) - Number('mode' in b.target || 'startUs' in b.target));
    for (const work of queued) {
      if (this.running.size >= this.concurrency) break;
      work.state = 'running'; work.seq++; this.running.add(work);
      work.done = this.run(work);
    }
  }
  private async run(work: Work) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let index: Awaited<ReturnType<typeof libraryAnalysisIndex>> | undefined;
    try {
      if (!(await this.library.resolve(work.mediaId, work.version)))
        throw new AnalysisFailure(
          "source-changed",
          "Analysis media changed before execution",
        );
      if (this.closed || work.state !== "running" || !work.consumers.size)
        return;
      if ('mode' in work.target && work.target.indexIdentity)
        index = await libraryAnalysisIndex(this.library, work.mediaId, work.version, work.filePath, work.target.indexIdentity);
      if (this.closed || work.state !== 'running' || !work.consumers.size) return;
      const worker = (work.worker = new Worker(
        new URL(
          typeof VOIDPLAYER_COMPILED !== "undefined" && VOIDPLAYER_COMPILED
            ? "./analysis/worker.ts"
            : "./worker.ts",
          import.meta.url,
        ),
        {
          workerData: {
            filePath: work.filePath,
            coreDir: this.coreDir,
            target: work.target,
            externalIndex: !!index,
          },
        },
      ));
      await new Promise<void>((resolve, reject) => {
        const armTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void worker.terminate(); reject(new AnalysisFailure('resource-limit', 'Analysis execution stalled'));
          }, 30000);
        };
        armTimer();
        const acknowledge = (value: unknown) => {
          try {
            worker.postMessage(value);
          } catch {
            /* A cancelled worker may already be gone. */
          }
        };
        worker.on("message", async (m) => {
          if (m.type === 'cache') {
            try {
              if (work.state !== 'running' || !work.consumers.size ||
                  m.picture?.sourceVersion !== work.target.sourceVersion)
                throw new AnalysisFailure('cancelled', 'Analysis demand expired');
              const id = createHash('sha256').update(JSON.stringify([
                work.target.sourceVersion, pictureId(m.picture), ANALYSIS_RECIPE, ANALYZER_VERSION, work.buildId,
              ])).digest('hex');
              acknowledge({ type: 'cache', result: await this.store.get(id) });
            } catch (error) { reject(error); }
            return;
          }
          if (m.type === 'index') {
            try { acknowledge({ type: 'index', index: await index!.read() }); }
            catch (error) { acknowledge({ type: 'index', error: String(error), reason: failureInfo(error) }); reject(error); }
            return;
          }
          if (m.type === 'progress') {
            if ('mode' in work.target && work.state === 'running') {
              work.progress = m.progress; work.seq++; armTimer();
            }
            return;
          }
          if (m.type === "chunk") {
            try {
              if (work.state !== "running" || !work.consumers.size)
                throw new Error("Analysis demand expired");
              const result: AnalysisResult = m.result;
              validateResult(result);
              if (
                result.picture.sourceVersion !== work.target.sourceVersion ||
                result.buildId !== work.buildId
              )
                throw new Error("Analysis worker identity mismatch");
              if (
                !("startUs" in work.target) && !("mode" in work.target) &&
                (result.sourcePtsUs !== work.target.sourcePtsUs ||
                  (work.target.picture &&
                    pictureId(result.picture) !==
                      pictureId(work.target.picture)))
              )
                throw new Error("Analysis worker target mismatch");
              if (
                "startUs" in work.target &&
                (result.sourcePtsUs <
                  work.target.firstPtsUs + work.target.startUs ||
                  result.sourcePtsUs >=
                    work.target.firstPtsUs + work.target.endUs)
              )
                throw new Error("Analysis worker range identity mismatch");
              if (!(await this.library.resolve(work.mediaId, work.version)))
                throw new AnalysisFailure(
                  "source-changed",
                  "Analysis source changed during execution",
                );
              if (result.confidence !== "exact") {
                // Unsupported summaries are transient lease-scoped control data,
                // never committed as exact chunks or complete range coverage.
                if (
                  result.blocks.length ||
                  JSON.stringify(result).length > 16384
                )
                  throw new AnalysisFailure(
                    "resource-limit",
                    "Unsupported summary budget exceeded",
                  );
                work.unsupportedResult = result;
                const reason = new AnalysisFailure(
                  result.reasonCodes?.[0] ?? "incomplete-reference-state",
                  result.reasons.join("; ") || "Exact analysis is unsupported",
                );
                work.reason = reason.info;
                work.state = "unsupported";
                work.seq++;
                throw reason;
              }
              const chunk =
                "startUs" in work.target || "mode" in work.target
                  ? createHash("sha256")
                      .update(
                        JSON.stringify([
                          result.picture.sourceVersion,
                          pictureId(result.picture),
                          ANALYSIS_RECIPE,
                          ANALYZER_VERSION,
                          work.buildId,
                        ]),
                      )
                      .digest("hex")
                  : work.id;
              if (!("mode" in work.target) && work.chunks.length >= 32)
                throw new AnalysisFailure(
                  "resource-limit",
                  "Analysis chunk count budget exceeded",
                );
              if ('mode' in work.target) {
                if (!result.gop) throw new Error('Missing stream GOP');
                const ref: StreamChunkRef = { id: chunk, cursor: work.published + 1, gop: result.gop };
                work.writing = new Set([this.store.chunkFile(chunk),
                  this.store.streamPageFile(work.id, Math.floor(work.published / 32))]);
                const protectedFiles = this.protectedFiles();
                await this.store.put(chunk, result, protectedFiles);
                if (work.state !== 'running' || !work.consumers.size) throw new AnalysisFailure('cancelled', 'Analysis demand expired');
                protectedFiles.add(this.store.chunkFile(chunk));
                const page = Math.floor(work.published / 32);
                if (!(work.published % 32)) work.page = [];
                work.page.push(ref);
                await this.store.putStreamPage(work.id, page, work.page, protectedFiles);
                work.published++; work.pending.push(ref); work.seq++; work.writing = undefined;
                if (work.pending.length >= 32) {
                  clearTimeout(timer); // Consumer wait is governed by leases, not decoder stall time.
                  await new Promise<void>(resolve => { work.wake = resolve; });
                }
                if (work.state !== 'running' || !work.consumers.size) throw new AnalysisFailure('cancelled', 'Analysis demand expired');
              } else {
                work.writing = new Set([this.store.chunkFile(chunk)]);
                await this.store.put(chunk, result);
                work.chunks.push(chunk); work.seq++; work.writing = undefined;
              }
              if ('mode' in work.target) armTimer();
              acknowledge({ ok: true });
            } catch (error) {
              acknowledge({
                ok: false,
                error: String(error),
                reason: failureInfo(error),
              });
              reject(error);
            }
          } else m.ok ? resolve() : reject(restoreFailure(m.reason, m.error));
        });
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("Analysis worker exited")));
      });
      if (work.state !== "running" || !work.consumers.size) return;
      if ('mode' in work.target && (!work.progress || work.published !== work.progress.totalPictures))
        throw new AnalysisFailure('incomplete-reference-state', 'Incomplete stream output');
      if ("startUs" in work.target)
        await this.store.putManifest(work.id, work.chunks);
      work.state = "complete";
      work.seq++;
    } catch (error) {
      if (work.state === "running") {
        work.reason = failureInfo(error);
        work.state = work.reason.kind;
        work.error = error instanceof Error ? error.message : String(error);
        work.seq++;
      }
    } finally {
      index?.close();
      clearTimeout(timer);
      await work.worker?.terminate();
      work.worker = undefined;
      work.writing = undefined; this.running.delete(work);
      void this.pump();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const entry of this.waitingReads.splice(0)) {
      entry.signal.removeEventListener('abort', entry.abort);
      entry.reject(new AnalysisFailure('cancelled', 'Analysis service closed'));
    }
    for (const id of this.consumers.keys()) this.release(id);
    await Promise.all([...this.running].map(work => work.done));
    await this.store.flush();
  }
}
