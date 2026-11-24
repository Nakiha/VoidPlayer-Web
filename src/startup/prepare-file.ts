import { abortableLoad, onLoadAbort } from '../../shared/media/io/media-abort.ts';
import type { MediaSource } from '../media/contract.ts';
import { openMedia } from '../media/source.ts';
import type { DecodeConfiguration } from '../media/policy/color-mode.ts';
import { offerVerifiedFrame } from '../media/policy/reference-source.ts';
import type { MediaOpenProgress } from '../media/progress.ts';

export type FileLaunchOpener = (signal: AbortSignal, progress: MediaOpenProgress, configuration: DecodeConfiguration) => Promise<MediaSource>;

export function prepareFirstFile(file: File, lifecycle: AbortSignal, initial: DecodeConfiguration) {
  const controller = new AbortController();
  const signal = controller.signal;
  let owned: MediaSource | undefined;
  let transferred = false;
  let attached = false;
  let latestStage: Parameters<MediaOpenProgress>[0] | undefined;
  let onProgress: MediaOpenProgress | undefined;
  const release = () => {
    const source = owned;
    owned = undefined;
    source?.dispose();
  };
  const discard = () => {
    if (transferred) return;
    controller.abort();
    release();
  };
  const detachLifecycle = onLoadAbort(lifecycle, discard);
  const result = (async () => {
    try {
      signal.throwIfAborted();
      owned = await openMedia(file, undefined, stage => { latestStage = stage; onProgress?.(stage); }, signal, initial);
      signal.throwIfAborted();
      const source = owned;
      latestStage = 'first-frame';
      onProgress?.(latestStage);
      const frame = await abortableLoad(source.frameAt(0), signal, late => late.close());
      if (signal.aborted) { frame.close(); signal.throwIfAborted(); }
      return offerVerifiedFrame(source, frame);
    } catch (error) {
      release();
      detachLifecycle();
      throw error;
    }
  })();
  void result.catch(() => {}); // Any early failure is delivered to the normal session load.
  const open: FileLaunchOpener = async (loadSignal, progress, configuration) => {
    if (attached || configuration.colorMode !== initial.colorMode) {
      if (!attached) { discard(); detachLifecycle(); }
      return openMedia(file, undefined, progress, loadSignal, configuration);
    }
    attached = true;
    const detachLoad = onLoadAbort(loadSignal, discard);
    try {
      onProgress = progress;
      if (latestStage) progress(latestStage);
      const source = await result;
      signal.throwIfAborted();
      transferred = true;
      owned = undefined;
      return source;
    } finally {
      onProgress = undefined;
      detachLifecycle();
      detachLoad();
    }
  };
  return { open, discard() { detachLifecycle(); discard(); } };
}
