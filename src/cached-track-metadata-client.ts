import type { MediaSource } from './media.ts';
import type { AudioPeek } from './cached-container-audio.ts';
import { inspectCachedTracks } from './cached-track-metadata.ts';
import { updateMediaInfo } from './media-state.ts';

/** One coalesced, bounded query for the visible inspector. No parser worker or
 * expanded byte retention is needed for muted tracks. Closing/replacing the
 * inspected source invalidates in-flight results and cancels trailing retries. */
export function attachCachedTrackMetadata(source: MediaSource, peek: AudioPeek) {
  let enabled = false, disposed = false, generation = 0, busy = false, last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  source.setMetadataInspectionEnabled = value => {
    if (enabled === value) return;
    enabled = value; generation++;
    clearTimeout(timer); timer = undefined;
  };
  source.requestCachedMetadata = () => {
    if (!enabled || disposed || busy || timer !== undefined) return;
    const known = source.info.trackMetadata;
    if (known?.audio.complete && (known.container !== 'MPEG-TS' || known.audio.presence === 'absent' || known.audio.tracks.every(t => t.codec && t.channels && t.sampleRate))) return;
    const delay = Math.max(0, 1000 - (performance.now() - last));
    timer = setTimeout(async () => {
      timer = undefined;
      if (!enabled || disposed) return;
      busy = true; last = performance.now(); const current = generation;
      try {
        const result = await inspectCachedTracks(source.info.size, async (offset, length) => {
          if (!enabled || disposed || generation !== current) return;
          return peek(offset, length);
        });
        if (!enabled || disposed || generation !== current) return;
        const previous = source.info.trackMetadata;
        // Cache eviction is not evidence that a previously identified track vanished.
        if (!result.container) result.container = previous?.container;
        if (previous && !result.audio.complete && (result.audio.presence === 'unknown' || previous.audio.complete)) result.audio = previous.audio;
        updateMediaInfo(source, { trackMetadata: result }, 'cached-metadata');
      } finally { busy = false; if (enabled && !disposed && current !== generation) source.requestCachedMetadata?.(); }
    }, delay);
  };
  return () => { disposed = true; enabled = false; generation++; clearTimeout(timer); timer = undefined; };
}
