import type { MediaSource, MediaMeta } from './media.ts';
import type { RandomAccessInput } from './range-reader.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { abortableLoad, loadAborted } from './media-abort.ts';
import { contextLog } from './log.ts';
import { explainMediaFailure } from './media-diagnostics.ts';
import { admitReferenceSource, referenceSource } from './reference-source.ts';

export interface MediaOpenPlan {
  meta: MediaMeta; input: RandomAccessInput; reference: boolean;
  softwareOnly: boolean; depth: number;
  /** Start FLV's software witness while the native adapter is opening. */
  parallelReferenceWitness?: boolean;
  native(): Promise<MediaSource>; software(): Promise<MediaSource>;
  onProgress?: MediaOpenProgress; signal?: AbortSignal;
}
/** All containers share preference, admission, failure-stage and ownership
 * rules. Adding a demuxer must not add a second native/color fallback policy. */
export function openMediaPlan(plan: MediaOpenPlan): Promise<MediaSource> {
  const log = contextLog();
  return abortableLoad((async () => {
    loadAborted(plan.signal);
    if (plan.softwareOnly) return referenceSource(await plan.software());
    let eagerSoftware: Promise<MediaSource> | undefined;
    let witnessClaimed = false, fallbackReturned = false;
    const softwareWitness = () => {
      if (!eagerSoftware) return plan.software();
      witnessClaimed = true;
      return eagerSoftware;
    };
    try {
      let nativeError: unknown;
      try {
        plan.onProgress?.('decode');
        if (plan.reference && plan.parallelReferenceWitness) {
          eagerSoftware = Promise.resolve().then(() => plan.software());
          eagerSoftware.catch(() => {});
        }
        let source = await plan.native();
        if (plan.reference) source = await admitReferenceSource(source, softwareWitness, plan.depth);
        log.info('media', source.info.decoder === 'webcodecs' ? '使用 WebCodecs 解码路径' : 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
        return source;
      } catch (error) { loadAborted(plan.signal); nativeError = error; }
      const stage = nativeError instanceof MediaOpenError ? nativeError.stage : 'decode';
      if (stage === 'input' || stage === 'resource') throw nativeError;
      log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: plan.meta.name, stage, reason: nativeError instanceof Error ? nativeError.message : String(nativeError) });
      try {
        plan.onProgress?.('decode');
        let source: MediaSource;
        if (eagerSoftware && !witnessClaimed) {
          fallbackReturned = true;
          source = await eagerSoftware;
        } else source = await plan.software();
        log.info('media', 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
        return plan.reference ? referenceSource(source) : source;
      } catch (fallbackError) {
        loadAborted(plan.signal);
        log.warn('media', 'WASM 回退也不支持', { name: plan.meta.name, error: String(fallbackError) });
        throw await explainMediaFailure(plan.input, nativeError, fallbackError, plan.signal);
      }
    } finally {
      // If native admission never consumed the eager open, release it once it
      // resolves (for example a non-WebCodecs adapter or input failure).
      if (eagerSoftware && !witnessClaimed && !fallbackReturned) void eagerSoftware.then(source => source.dispose(), () => {});
    }
  })(), plan.signal, source => source.dispose());
}
