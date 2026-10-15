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
type AnalysisTask = { intent: 'explicit' | 'automatic'; settled: Promise<void>; generation: number; controller?: AbortController; service?: BitstreamAnalysisService; state?: DeepAnalysisState; retainedStream?: DeepAnalysisState['stream']; result?:Promise<unknown> };
type AnalysisQueries = Pick<BitstreamAnalysisService, 'queryDiagrams' | 'chartBounds' | 'queryChart' | 'cached'>;

/** Owns admission, per-track task cancellation and completion; never frames. */
export class BitstreamSessionCoordinator {
  private root?: BitstreamAnalysisService;
  private loading?: Promise<BitstreamAnalysisService>;
  private pool = new AnalysisTaskPool();
  private lastSlot?: Slot;
  private completed = new Map<Slot, { generation: number; progress: NonNullable<DeepAnalysisState['completedStream']> }>();
  private tasks = new Map<Slot, AnalysisTask>();
  private automatic = new Map<Slot, object>();
  private readonly host: AnalysisHost;
  constructor(host: AnalysisHost) { this.host = host; }
  get queries(): AnalysisQueries | undefined { return this.root; }
  get concurrency() { return this.pool.concurrency; }
  setConcurrency(value: number) { this.pool.setConcurrency(value); this.host.changed(); }

  async run<T>(slot: Slot, signal: AbortSignal | undefined, initial: DeepAnalysisState,
    run: (service: BitstreamAnalysisService, signal: AbortSignal) => Promise<T>, intent: 'explicit' | 'automatic' = 'explicit'): Promise<T> {
    const track = this.host.track(slot);
    if (!track?.available) throw new AnalysisFailure('invalid-request', 'Track unavailable');
    signal?.throwIfAborted();
    if (intent === 'automatic') {
      const demand = {}; this.automatic.set(slot, demand);
      // Explicit UI/Agent work owns its lifetime. Only the newest automatic
      // window survives while it waits, including repeated explicit requests.
      while (this.tasks.get(slot)?.controller && this.tasks.get(slot)?.intent === 'explicit') {
        const task = this.tasks.get(slot)!;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          task.settled.then(resolve).finally(() => signal?.removeEventListener('abort', abort));
          if (signal?.aborted) abort();
        });
      }
      signal?.throwIfAborted();
      const current = this.host.track(slot);
      if (current?.instance !== track.instance || current.generation !== track.generation || !current.available)
        throw new AnalysisFailure('source-changed', 'Analysis source changed');
      if (this.automatic.get(slot) !== demand || this.state(slot).state === 'paused')
        throw new AnalysisFailure('cancelled', 'Automatic viewport superseded');
    }
    const matching=this.tasks.get(slot);
    if(intent==='automatic' && initial.stream?.window && matching?.controller && matching.intent==='automatic' && matching.generation===track.generation && matching.service?.sameDemand(initial.stream.window) && matching.result) {
      matching.service.displayWindow(initial.stream.window); return await matching.result as T;
    }
    const previous = this.state(slot);
    const retainedStream = initial.stream && previous.state === 'paused' && JSON.stringify(initial.stream.window) === JSON.stringify(previous.stream?.window) ? previous.stream : undefined;
    this.cancel(slot, true, true);
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const task: AnalysisTask = { intent, settled, generation: track.generation, controller, retainedStream, state: { ...initial, ...(retainedStream ? { stream: retainedStream } : {}), queued: true } };
    let resultResolve!:(value:unknown)=>void,resultReject!:(error:unknown)=>void;task.result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});void task.result.catch(()=>{});
    this.tasks.set(slot, task); this.lastSlot = slot;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const off = this.host.subscribeInvalidation(() => {
      const current = this.host.track(slot);
      if (current?.instance !== track.instance || current.generation !== track.generation || !current.available)
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
      const value=await run(task.service, controller.signal); resultResolve(value);return value;
    } catch (error) {
      resultReject(error);
      if (task.state?.state !== 'paused' && (!task.service || task.service.state.state === 'idle')) {
        const reason = failureInfo(controller.signal.aborted ? controller.signal.reason : error);
        task.state = { ...initial, state: reason.kind, reason, message: reason.message };
        this.host.changed();
      }
      throw error;
    } finally {
      off(); signal?.removeEventListener('abort', abort);
      if (this.tasks.get(slot) === task) task.controller = undefined;
      release?.(); settle();
    }
  }

  state(slot?: Slot): DeepAnalysisState {
    const selected = slot ?? this.lastSlot;
    const generation = selected === undefined ? undefined : this.host.track(selected)?.generation;
    const task = selected === undefined ? undefined : this.tasks.get(selected);
    const completion = selected === undefined ? undefined : this.completed.get(selected);
    const state = task && (slot === undefined || task.generation === generation) ? task.state ?? task.service?.state ?? { state: 'idle' as const } : { state: 'idle' as const };
    const stream = state.stream;
    return structuredClone({ ...state, ...(stream ? { stream } : {}), ...(completion && completion.generation === generation ? { completedStream: completion.progress } : {}) });
  }

  pause(slot: Slot) {
    const state = this.state(slot), task = this.tasks.get(slot);
    if (!task || state.state !== 'pending' || !state.stream) return;
    this.automatic.delete(slot);
    task.state = { state: 'paused', stream: state.stream };
    task.controller?.abort(new AnalysisFailure('cancelled', 'Analysis paused'));
    task.service?.cancel();
    this.host.changed();
  }

  cancel(slot?: Slot, preservePaused = false, preserveAutomatic = false) {
    if (!preserveAutomatic) { if (slot === undefined) this.automatic.clear(); else this.automatic.delete(slot); }
    for (const [key, task] of this.tasks) {
      if (slot !== undefined && key !== slot) continue;
      const reason = new AnalysisFailure('cancelled', 'Analysis cancelled');
      if (task.state?.state === 'paused' && !preservePaused) { task.state = { ...task.state, state: 'cancelled', reason: reason.info }; this.host.changed(); }
      if (!task.controller) continue;
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
