import type { Slot } from '../model.ts';
import type { BitstreamAnalysisService, DeepAnalysisState } from '../bitstream-analysis/service.ts';
import { AnalysisFailure, failureInfo } from '../bitstream-analysis/failure.ts';
import { AnalysisTaskPool } from '../bitstream-analysis/task-pool.ts';

/** The instance is opaque: only Session can inspect or mutate a track/source. */
export interface AnalysisTrackSnapshot {
  readonly instance: object;
  readonly generation: number;
  readonly available: boolean;
}
interface AnalysisHost {
  track(slot: Slot): AnalysisTrackSnapshot | undefined;
  subscribeInvalidation(listener: () => void): () => void;
  changed(): void;
}
type AnalysisTask = { generation: number; controller?: AbortController; service?: BitstreamAnalysisService; state?: DeepAnalysisState };
type AnalysisQueries = Pick<BitstreamAnalysisService, 'queryDiagrams' | 'chartBounds' | 'queryChart' | 'cached'>;

/** Owns admission, per-track task cancellation and completion; never frames. */
export class BitstreamSessionCoordinator {
  private root?: BitstreamAnalysisService;
  private loading?: Promise<BitstreamAnalysisService>;
  private pool = new AnalysisTaskPool();
  private lastSlot?: Slot;
  private completed = new Map<Slot, { generation: number; progress: NonNullable<DeepAnalysisState['completedStream']> }>();
  private tasks = new Map<Slot, AnalysisTask>();
  private readonly host: AnalysisHost;
  constructor(host: AnalysisHost) { this.host = host; }
  get queries(): AnalysisQueries | undefined { return this.root; }
  get concurrency() { return this.pool.concurrency; }
  setConcurrency(value: number) { this.pool.setConcurrency(value); this.host.changed(); }

  async run<T>(slot: Slot, signal: AbortSignal | undefined, initial: DeepAnalysisState,
    run: (service: BitstreamAnalysisService, signal: AbortSignal) => Promise<T>): Promise<T> {
    const track = this.host.track(slot);
    if (!track?.available) throw new AnalysisFailure('invalid-request', 'Track unavailable');
    signal?.throwIfAborted();
    this.cancel(slot);
    const controller = new AbortController();
    const task: AnalysisTask = { generation: track.generation, controller, state: { ...initial, queued: true } };
    this.tasks.set(slot, task); this.lastSlot = slot;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const off = this.host.subscribeInvalidation(() => {
      const current = this.host.track(slot);
      if (current?.instance !== track.instance || !current.available)
        controller.abort(new AnalysisFailure('source-changed', 'Analysis source changed'));
    });
    this.host.changed();
    let release: (() => void) | undefined;
    try {
      release = await this.pool.acquire(controller.signal);
      if (!this.loading) this.loading = import('../bitstream-analysis/service.ts').then(({ BitstreamAnalysisService }) =>
        this.root = new BitstreamAnalysisService(() => this.host.changed()));
      const root = await this.loading;
      controller.signal.throwIfAborted();
      task.service = root.fork(() => this.host.changed());
      // From here the track service publishes its own running/terminal state.
      task.state = undefined;
      return await run(task.service, controller.signal);
    } catch (error) {
      if (!task.service || task.service.state.state === 'idle') {
        const reason = failureInfo(controller.signal.aborted ? controller.signal.reason : error);
        task.state = { ...initial, state: reason.kind, reason, message: reason.message };
        this.host.changed();
      }
      throw error;
    } finally {
      off(); signal?.removeEventListener('abort', abort);
      if (this.tasks.get(slot) === task) task.controller = undefined;
      release?.();
    }
  }

  state(slot?: Slot): DeepAnalysisState {
    const selected = slot ?? this.lastSlot;
    const generation = selected === undefined ? undefined : this.host.track(selected)?.generation;
    const task = selected === undefined ? undefined : this.tasks.get(selected);
    const completion = selected === undefined ? undefined : this.completed.get(selected);
    const state = task && (slot === undefined || task.generation === generation) ? task.state ?? task.service?.state ?? { state: 'idle' as const } : { state: 'idle' as const };
    return structuredClone({ ...state, ...(completion && completion.generation === generation ? { completedStream: completion.progress } : {}) });
  }

  cancel(slot?: Slot) {
    for (const [key, task] of this.tasks) {
      if (slot !== undefined && key !== slot) continue;
      if (!task.controller) continue;
      const reason = new AnalysisFailure('cancelled', 'Analysis cancelled');
      task.controller.abort(reason);
      if (task.state?.queued) { task.state = { ...task.state, state: 'cancelled', queued: false, reason: reason.info }; this.host.changed(); }
      task.service?.cancel();
    }
  }

  complete(slot: Slot, generation: number, progress: NonNullable<DeepAnalysisState['completedStream']>) {
    this.completed.set(slot, { generation, progress });
    this.host.changed();
  }

  dispose() {
    this.cancel();
    this.tasks.clear(); this.completed.clear(); this.root?.dispose();
  }
}
