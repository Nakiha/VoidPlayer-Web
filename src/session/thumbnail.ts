import { log } from '../log.ts';
import type { DecodedFrame, MediaSource } from '../media.ts';
import { referenceVersion } from '../../shared/media/io/media-reference.ts';
import type { Slot } from '../../shared/review/model.ts';
import { localCacheKey, serverCacheKey } from '../../shared/thumbnails/contract.ts';
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
  slot: Slot,
  source: MediaSource,
  frame: DecodedFrame,
  localTarget: number,
  sourceGen: number,
  resources: SessionResources,
  isLive: () => boolean,
) {
  const started = performance.now();
  try {
    const isFileFirst = localTarget === 0 && frame.ptsUs === 0;
    const libraryId = source.info.source?.id;
    const mediaVersion = referenceVersion(source.info.source?.url);
    let cacheKey: string;
    let kind: 'library' | 'local';
    let epoch: number | undefined;
    if (libraryId) {
      // Without a reliable media version, a replaced same-name file would
      // inherit the old cover: stay missing instead of uploading a cache.
      if (!mediaVersion) {
        thumbnailState.skip('upload:no-epoch-or-version');
        log.debug('media', '首帧缩图候选未接受', { reason: 'upload:no-epoch-or-version', sourcePtsUs: frame.sourcePtsUs, decoder: source.info.decoder });
        return;
      }
      kind = 'library';
      cacheKey = serverCacheKey({ mediaId: libraryId, mediaVersion });
      // Frozen at accept; a missing epoch means local-only this time, with
      // no network wait while the full frame is held.
      epoch = thumbnailState.cachedEpoch(cacheKey);
    } else {
      kind = 'local';
      cacheKey = localCacheKey(source.info.name, source.info.size, source.info.lastModified);
    }
    const offered = offerFirstFrameCandidate({
      resources, cacheKey, kind, libraryId, mediaVersion, sourceGen,
      sourcePtsUs: frame.sourcePtsUs, isFileFirst, epoch,
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
