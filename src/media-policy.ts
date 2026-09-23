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
    let nativeError: unknown;
    try {
      plan.onProgress?.('decode');
      let source = await plan.native();
      if (plan.reference) source = await admitReferenceSource(source, plan.software, plan.depth);
      log.info('media', source.info.decoder === 'webcodecs' ? '使用 WebCodecs 解码路径' : 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
      return source;
    } catch (error) { loadAborted(plan.signal); nativeError = error; }
    const stage = nativeError instanceof MediaOpenError ? nativeError.stage : 'decode';
    if (stage === 'input' || stage === 'resource') throw nativeError;
    log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: plan.meta.name, stage, reason: nativeError instanceof Error ? nativeError.message : String(nativeError) });
    try {
      plan.onProgress?.('decode');
      const source = await plan.software();
      log.info('media', 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
      return plan.reference ? referenceSource(source) : source;
    } catch (fallbackError) {
      loadAborted(plan.signal);
      log.warn('media', 'WASM 回退也不支持', { name: plan.meta.name, error: String(fallbackError) });
      throw await explainMediaFailure(plan.input, nativeError, fallbackError, plan.signal);
    }
  })(), plan.signal, source => source.dispose());
}
