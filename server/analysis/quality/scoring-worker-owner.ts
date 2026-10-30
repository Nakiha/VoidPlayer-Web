import type { QualityExecutionContract } from "../../../shared/analysis/quality/reexecution.ts";
import { Worker } from "node:worker_threads";
import type { MediaLibraryIndex } from "../../library.ts";
import { AdminError } from "../../admin-error.ts";
import type {QualityExecutor} from '../../../shared/service/quality-resources.ts';
declare const VOIDPLAYER_COMPILED: boolean;
class ScoringWorkerError extends AdminError {
  constructor(code: string, message: string) {
    super(
      ["component-unavailable", "stop-uncertain"].includes(code) ? 503 : 400,
      message,
      code,
    );
  }
}
/** One admission spans all Workers, source IO and parent-side result sinks.
 * It is released only after physical exit and completion of outstanding sinks. */
export class ScoringWorkerOwner {
  private active = new Set<{ stop(): void; done: Promise<unknown> }>();
  private closed = false;
  stopUncertain = false;
  protected library: MediaLibraryIndex;
  protected coreDir: string;
  private executor: QualityExecutor;
  constructor(library: MediaLibraryIndex, coreDir: string, executor: QualityExecutor = 'inspection') {
    this.library = library;
    this.coreDir = coreDir;
    this.executor = executor;
  }
  get admission() { return this.library.qualityAdmission; }
  protected createWorker(url: URL, data: object) {
    return new Worker(url, {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      trackUnmanagedFds: true,
    });
  }
  protected worker<T>(
    entry: string,
    data: object,
    signal: AbortSignal,
    progress?: (n: number, total: number) => void,
    onContract?: (value: QualityExecutionContract) => void,
    onEvent?: (message: Record<string, any>) => Promise<void|{stopRequested?:boolean}>,
  ): Promise<T> {
    const control = new Int32Array(new SharedArrayBuffer(8));
    const url = new URL(
      typeof VOIDPLAYER_COMPILED !== "undefined" && VOIDPLAYER_COMPILED
        ? `./analysis/vmaf/${entry}`
        : `../vmaf/${entry}`,
      import.meta.url,
    );
    const worker = this.createWorker(url, { ...data, control: control.buffer });
    return new Promise<T>((resolve, reject) => {
      let finishing = false,
        exited = false,
        eventWork: Promise<void|{stopRequested?:boolean}> | undefined;
      const finish = async (ok: boolean, value: unknown) => {
        if (finishing) return;
        finishing = true;
        signal.removeEventListener("abort", abort);
        Atomics.store(control, 0, 1);
        try {
          for (;;) {
            const n = Atomics.load(control, 1);
            if (!n) break;
            if (exited)
              throw new ScoringWorkerError(
                "stop-uncertain",
                "Decode Worker exited with open source IO",
              );
            const w = (
              Atomics as typeof Atomics & {
                waitAsync(
                  a: Int32Array,
                  i: number,
                  n: number,
                ): { value: Promise<string> | string };
              }
            ).waitAsync(control, 1, n);
            await w.value;
          }
          await worker.terminate();
          await eventWork?.catch(() => {});
          if (signal.aborted) reject(signal.reason);
          else if (ok) resolve(value as T);
          else reject(value);
        } catch (error) {
          this.stopUncertain = true;
          reject(error);
        } finally {
          worker.removeAllListeners();
        }
      };
      const abort = () => void finish(false, signal.reason);
      worker.on("message", (message) => {
        if (finishing) return;
        if (message.type === "scoring-frame") {
          eventWork = Promise.resolve().then(() => {
            if (!onEvent) throw new Error("Unexpected scoring event");
            return onEvent(message);
          });
          void eventWork.then(
            (outcome) => {
              if (!finishing)
                worker.postMessage({
                  type: "scoring-ack",
                  index: message.index,
                  stopRequested: outcome?.stopRequested===true,
                });
            },
            (error) => void finish(false, error),
          );
          return;
        }
        if (message.type === "execution-contract") {
          try {
            onContract?.(message.contract);
          } catch (error) {
            void finish(false, error);
          }
          return;
        }
        if (message.type === "progress") {
          try {
            progress?.(message.frames, message.total);
          } catch (error) {
            void finish(false, error);
          }
          return;
        }
        void finish(
          message.ok === true,
          message.ok
            ? message.value
            : new ScoringWorkerError(
                message.error?.code ?? "execution-failed",
                message.error?.message ?? "Scoring Worker failed",
              ),
        );
      });
      worker.once("error", (error) => void finish(false, error));
      worker.once(
        "messageerror",
        () =>
          void finish(
            false,
            new ScoringWorkerError("execution-failed", "Invalid Worker reply"),
          ),
      );
      worker.once("exit", () => {
        exited = true;
        Atomics.notify(control, 1);
        if (!finishing)
          void finish(
            false,
            new ScoringWorkerError(
              "execution-failed",
              "Scoring Worker exited without a result",
            ),
          );
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  protected owned<T>(
    input: { budget: { maxElapsedMs: number } },
    signal: AbortSignal,
    admitted: () => void,
    work: (s: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed || this.stopUncertain)
      return Promise.reject(
        new ScoringWorkerError(
          "component-unavailable",
          "Scoring executor is stopping or unavailable",
        ),
      );
    let release: () => void;
    try {
      signal.throwIfAborted();
      // One scalar Worker runs decoder and scorer on the same thread. Reserve
      // its JS heap, decoder heaps, retained planes/indexes and analysis memory.
      release = this.admission.acquire({executor:this.executor, memoryBytes:1280*1024**2, readBytes:2*1024**3, threads:1});
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(
      () =>
        controller.abort(
          new ScoringWorkerError(
            "budget-exceeded",
            "Whole scoring execution deadline exceeded",
          ),
        ),
      input.budget.maxElapsedMs,
    );
    const entry = {
      stop: () =>
        controller.abort(
          new ScoringWorkerError("cancelled", "Scoring executor stopping"),
        ),
      done: Promise.resolve() as Promise<unknown>,
    };
    const done = Promise.resolve().then(async () => {
      try {
        admitted();
        combined.throwIfAborted();
        return await work(combined);
      } finally {
        clearTimeout(timer);
        this.active.delete(entry);
        if (!this.stopUncertain) release();
      }
    });
    entry.done = done;
    this.active.add(entry);
    return done;
  }
  close() {
    this.closed = true;
    for (const e of this.active) e.stop();
    return Promise.allSettled([...this.active].map((e) => e.done)).then(() => {
      if (this.stopUncertain)
        throw new ScoringWorkerError(
          "stop-uncertain",
          "Scoring executor exit is uncertain",
        );
    });
  }
}
