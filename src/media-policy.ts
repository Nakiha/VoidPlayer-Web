import type { MediaSource, MediaMeta } from './media.ts';
import type { RandomAccessInput } from './range-reader.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { abortableLoad, loadAborted } from './media-abort.ts';
import { contextLog } from './log.ts';
import { explainMediaFailure } from './media-diagnostics.ts';
import { admitReferenceSource, referenceSource } from './reference-source.ts';
import type { ReferenceDecode } from './color-mode.ts';

export interface MediaOpenPlan {
  meta: MediaMeta; input: RandomAccessInput; reference: boolean;
  softwareOnly: boolean; depth: number;
  native(): Promise<MediaSource>; software(): Promise<MediaSource>;
  /** The selected container session owns its decoder fallback in place. */
  nativeOwnsFallback?: boolean;
  onProgress?: MediaOpenProgress; signal?: AbortSignal;
}
/** All containers share preference, admission, failure-stage and ownership
 * rules. Adding a demuxer must not add a second native/color fallback policy. */
export function openMediaPlan(plan: MediaOpenPlan): Promise<MediaSource> {
  const log = contextLog();
  return abortableLoad((async () => {
    loadAborted(plan.signal);
    const admit = async (source: MediaSource) => {
      if (!plan.reference) return source;
      if (source.admitReference) return source.admitReference(plan.depth);
      if (source.reconfigureColorMode) {
        await source.reconfigureColorMode('reference', { decoder: source.info.decoder === 'webcodecs' ? 'hardware' : 'software', depth: plan.depth as ReferenceDecode['depth'] }, plan.signal);
        return source;
      }
      return admitReferenceSource(source, plan.software, plan.depth);
    };
    if (plan.softwareOnly) {
      const software = await plan.software();
      try { return plan.reference ? await admit(software) : software; }
      catch (error) { software.dispose(); throw error; }
    }
    let nativeError: unknown;
    let source: MediaSource | undefined;
    let adapterManagedAdmission = false;
    try {
      plan.onProgress?.('decode');
      source = await plan.native();
      if (plan.reference && (source.admitReference || source.reconfigureColorMode)) {
        adapterManagedAdmission = true;
        source = await admit(source);
        adapterManagedAdmission = false;
      } else if (plan.reference) {
        source = await admit(source);
      }
      log.info('media', source.info.decoder === 'webcodecs' ? '使用 WebCodecs 解码路径' : 'WASM 回退解码已启用', { name: plan.meta.name, codec: source.info.codec });
      return source;
    } catch (error) {
      loadAborted(plan.signal);
      if (adapterManagedAdmission) { source?.dispose(); throw error; }
      if (plan.nativeOwnsFallback) throw error;
      nativeError = error;
    }
    const stage = nativeError instanceof MediaOpenError ? nativeError.stage : 'decode';
    if (stage === 'input' || stage === 'resource') throw nativeError;
    log.info('media', 'WebCodecs 路径不可用，尝试 WASM 回退', { name: plan.meta.name, stage, reason: nativeError instanceof Error ? nativeError.message : String(nativeError) });
    let fallbackSource: MediaSource | undefined;
    try {
      plan.onProgress?.('decode');
      fallbackSource = await plan.software();
      log.info('media', 'WASM 回退解码已启用', { name: plan.meta.name, codec: fallbackSource.info.codec });
      return plan.reference ? await admit(fallbackSource) : fallbackSource;
    } catch (fallbackError) {
      fallbackSource?.dispose();
      loadAborted(plan.signal);
      log.warn('media', 'WASM 回退也不支持', { name: plan.meta.name, error: String(fallbackError) });
      throw await explainMediaFailure(plan.input, nativeError, fallbackError, plan.signal);
    }
  })(), plan.signal, source => source.dispose());
}
