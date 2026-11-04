import type { VvcTuningAxis, VvcTuningState } from '../contract.ts';
import type { DecodeThreads } from '../policy/wasm-threads.ts';

type Limits = NonNullable<Extract<DecodeThreads, object>['vvcTuning']>;
type TuningCore = {
  _vp_vvc_tuning?(ctx: number): number;
  _vp_set_vvc_frame_context_capacity(count: number): void;
  _vp_set_vvc_thread_capacity(count: number): void;
  _vp_grow_vvc_threads(ctx: number, count: number): number;
  _vp_grow_vvc_frame_contexts(ctx: number, count: number): number;
  _vp_set_threads(count: number): void;
  _vp_set_vvc_threads?(count: number): void;
  _vp_set_vvc_frame_contexts(count: number): void;
};

/** Configure before opening the codec. Queries and growth run between decoder operations. */
export function createVvcTuner(core: TuningCore, heap: () => Uint8Array, ctx: number, limits?: Limits) {
  if (!limits || typeof core._vp_vvc_tuning !== 'function') return;
  core._vp_set_vvc_frame_context_capacity(limits.contexts);
  core._vp_set_vvc_thread_capacity(limits.threads);
  let inputWaitMs = 0, sampledAt = performance.now();
  const read = (): VvcTuningState | null => {
    const ptr = core._vp_vvc_tuning!(ctx) >>> 0;
    if (!ptr) return null;
    const bytes = heap(), view = new DataView(bytes.buffer, ptr, 32);
    const get = (index: number) => view.getInt32(index * 4, true);
    const now = performance.now();
    const result = { threads: get(0), contexts: get(1), inFlight: get(2), dispatched: get(3), saturated: get(4),
      submitted: get(5), full: get(6), maxFrameWaitUs: get(7), heapBytes: bytes.byteLength,
      maxThreads: limits.threads, maxContexts: limits.contexts, inputWaitMs, sampleMs: now - sampledAt };
    inputWaitMs = 0; sampledAt = now;
    return result;
  };
  return {
    recordInputWait(ms: number) { inputWaitMs += ms; },
    tune(axis?: VvcTuningAxis): VvcTuningState | null {
      const before = read();
      if (!before || !axis) return before;
      const current = before[axis], limit = axis === 'threads' ? before.maxThreads : before.maxContexts;
      const count = Math.min(limit, current + 2);
      if (count <= current) return { ...before, rejected: 'core' };
      const projected = axis === 'contexts' ? before.heapBytes * count / current : before.heapBytes + (count - current) * 8 * 1024 ** 2;
      if (projected + 128 * 1024 ** 2 > 3 * 1024 ** 3) return { ...before, rejected: 'budget' };
      const active = axis === 'threads' ? core._vp_grow_vvc_threads(ctx, count) : core._vp_grow_vvc_frame_contexts(ctx, count);
      if (active > current) {
        if (axis === 'threads') {
          core._vp_set_threads(active);
          core._vp_set_vvc_threads?.(active);
        } else core._vp_set_vvc_frame_contexts(active);
      }
      return { ...(read() ?? before), inputWaitMs: before.inputWaitMs, sampleMs: before.sampleMs,
        ...(active <= current ? { rejected: 'core' as const } : {}) };
    },
  };
}
