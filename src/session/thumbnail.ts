import { log } from '../logging/log.ts';
import type { DecodedFrame, MediaSource } from '../media/contract.ts';
import { localCacheKey } from '../../shared/thumbnails/contract.ts';
import { offerFirstFrameCandidate, settleOffer } from '../thumbnails/offer.ts';
import { thumbnailState } from '../thumbnails/state.ts';
import type { SessionResources } from './resources.ts';

/**
 * Thumbnail bypass for a committed first frame. Synchronous, non-throwing,
 * and measured: validation, dedupe, budget and one independent resource
 * reference only. file-first means the load resolved the media origin
 * (localTarget===0) and the decoded frame is the timeline origin
 * (frame.ptsUs===0 with its real sourcePtsUs recorded). Anything else —
 * non-zero joins, workspace restores at an offset, track syncs — offers
 * nothing and never seeks. No extra Range/MediaSource/frameAt/index work:
 * see thumbnails/state.ts counters.
 */
export function offerSessionThumbnail(
  source: MediaSource,
  frame: DecodedFrame,
  localTarget: number,
  sourceGen: number,
  resources: SessionResources,
  isLive: () => boolean,
) {
  if (source.info.source?.kind === 'library') return;
  const started = performance.now();
  try {
    const isFileFirst = localTarget === 0 && frame.ptsUs === 0;
    const cacheKey = localCacheKey(source.info.name, source.info.size, source.info.lastModified);
    const offered = offerFirstFrameCandidate({
      resources, cacheKey, sourceGen,
      sourcePtsUs: frame.sourcePtsUs, isFileFirst,
      byteSize: frame.byteSize, isLive,
    }, frame);
    const offerResult = typeof offered === 'string' ? offered : offered.result;
    log.debug('media', '首帧缩图候选已检查', {
      result: offerResult, localTarget, framePtsUs: frame.ptsUs, sourcePtsUs: frame.sourcePtsUs,
      kind: frame.kind, decoder: source.info.decoder,
    });
    if (typeof offered === 'string' || offered.result !== 'accepted') return;
    // Detached continuation; the module is already cached via workbench init.
    // An import failure must still release the held reference, never leak it.
    void import('../thumbnails/tasks.ts').then(
      tasks => tasks.runThumbnailTask(offered),
      () => { offered.release(); settleOffer(offered.context.cacheKey, false); },
    ).catch(() => {});
  } catch (error) {
    log.debug('media', '首帧缩图候选检查失败', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    thumbnailState.noteHook(performance.now() - started);
  }
}
