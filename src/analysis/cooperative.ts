import { executeSortedQuerySteps } from './adapters.ts';
import type { PacketView, SortedAxis, SourceQueryContext } from './adapters.ts';
import type { AnalysisQuery, AnalysisResult } from './types.ts';
import { lowerBound } from './statistics.ts';

const BATCH = 4096;
/** Stable bounded merges, including prefix construction. No native full-array
 * sort can hide an uninterruptible long task inside this worker path. */
function* sortedPackets(packets: ArrayLike<PacketView>, firstPtsUs: number, axis: 'pts' | 'dts',
  previous?: { sorted: SortedAxis; length: number }): Generator<void, SortedAxis> {
  let fresh: { pos: number; t: number }[] = [];
  for (let i = previous?.length ?? 0; i < packets.length; i++) {
    if (i % BATCH === 0) yield;
    const raw = axis === 'pts' ? packets[i].pts : packets[i].dts;
    if (raw != null && Number.isFinite(raw)) fresh.push({ pos: i, t: raw - firstPtsUs });
  }
  const compare = (a: { pos: number; t: number }, b: { pos: number; t: number }) => a.t - b.t || a.pos - b.pos;
  const run = 512;
  for (let i = 0; i < fresh.length; i += run) {
    yield;
    const chunk = fresh.slice(i, i + run).sort(compare);
    for (let j = 0; j < chunk.length; j++) fresh[i+j] = chunk[j];
  }
  let scratch = new Array<(typeof fresh)[number]>(fresh.length);
  for (let width = run; width < fresh.length; width *= 2) {
    let work = 0;
    for (let start = 0; start < fresh.length; start += width * 2) {
      const middle = Math.min(start + width, fresh.length), end = Math.min(start + width * 2, fresh.length);
      let left = start, right = middle;
      for (let k = start; k < end; k++) {
        if (++work % BATCH === 0) yield;
        scratch[k] = right >= end || left < middle && compare(fresh[left], fresh[right]) <= 0 ? fresh[left++] : fresh[right++];
      }
    }
    [fresh, scratch] = [scratch, fresh];
  }
  const old = previous?.sorted, oldLength = old?.order.length ?? 0, length = oldLength + fresh.length;
  const order = new Array<number>(length), times = new Float64Array(length), prefix = new Float64Array(length + 1);
  let left = 0, right = 0;
  for (let i = 0; i < length; i++) {
    if (i % BATCH === 0) yield;
    const useOld = left < oldLength && (right >= fresh.length || old!.times[left] < fresh[right].t
      || old!.times[left] === fresh[right].t && old!.order[left] < fresh[right].pos);
    const pos = useOld ? old!.order[left] : fresh[right].pos;
    order[i] = pos; times[i] = useOld ? old!.times[left++] : fresh[right++].t;
    prefix[i+1] = prefix[i] + packets[pos].size;
  }
  return { order, times, prefix };
}

/** Cache is committed only after the index is complete. Abandoning a generator
 * leaves the preceding index intact, so cancellation cannot publish half a sort. */
export function createCooperativeQuerier() {
  let cached: { packets: ArrayLike<PacketView>; length: number; firstPtsUs: number; axis: string; sorted: SortedAxis } | undefined;
  function* sortedFor(packets: ArrayLike<PacketView>, firstPtsUs: number, axis: 'pts' | 'dts'): Generator<void, SortedAxis> {
    const previous = cached?.packets === packets && cached.firstPtsUs === firstPtsUs && cached.axis === axis ? cached : undefined;
    if (previous?.length === packets.length) return previous.sorted;
    const sorted = yield* sortedPackets(packets, firstPtsUs, axis, previous && previous.length < packets.length ? previous : undefined);
    cached = { packets, length: packets.length, firstPtsUs, axis, sorted }; return sorted;
  }
  return {
    *query(packets: ArrayLike<PacketView>, ctx: SourceQueryContext, query: AnalysisQuery & { requestId: number }): Generator<void, AnalysisResult> {
      if (!ctx.capability.hasDts && query.axis === 'dts') throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
      const sorted = yield* sortedFor(packets, ctx.firstPtsUs, query.axis);
      return yield* executeSortedQuerySteps(packets, ctx, query, Math.min(query.startUs, query.endUs), Math.max(query.startUs, query.endUs), query.maxSamples ?? 5000, sorted);
    },
    *rank(packets: ArrayLike<PacketView>, firstPtsUs: number, axis: 'pts' | 'dts', tUs: number) {
      if (axis !== 'pts' && axis !== 'dts' || !Number.isFinite(tUs)) throw new Error('Invalid analysis rank.');
      const sorted = yield* sortedFor(packets, firstPtsUs, axis), at = lowerBound(sorted.times, tUs);
      return { rank: at, total: sorted.times.length, ordinal: sorted.times[at] === tUs ? packets[sorted.order[at]].ordinal ?? sorted.order[at] : null };
    },
    *number(packets: ArrayLike<PacketView>, firstPtsUs: number, axis: 'pts' | 'dts', number: number): Generator<void, number | null> {
      if (!Number.isSafeInteger(number) || number < 0 || axis !== 'pts' && axis !== 'dts') return null;
      if (axis === 'dts') { const pts = packets[number]?.pts; return pts == null ? null : pts - firstPtsUs; }
      const sorted = yield* sortedFor(packets, firstPtsUs, 'pts');
      return number < sorted.times.length ? (packets[sorted.order[number]].pts as number) - firstPtsUs : null;
    },
  };
}

/** Limit each worker turn by both operation batches and elapsed time. */
export async function driveAnalysis<T>(steps: Generator<void, T>, cancelled: () => boolean,
  yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0))): Promise<T> {
  try {
    let deadline = performance.now() + 4;
    while (true) {
      if (cancelled()) throw new DOMException('Analysis query cancelled.', 'AbortError');
      const next = steps.next(); if (next.done) return next.value;
      if (performance.now() >= deadline) { await yieldControl(); deadline = performance.now() + 4; }
    }
  } finally { steps.return(undefined as T); }
}
