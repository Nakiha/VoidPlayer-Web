import type { MediaSource } from '../contract.ts';
import type { AudioPeek } from '../../../shared/media/audio-types.ts';
import { inspectCachedTracks } from '../../../shared/media/containers/cached-track-metadata.ts';
import type { CachedTrackMetadata } from '../../../shared/media/containers/cached-track-metadata.ts';
import { updateMediaInfo } from '../state.ts';

/** One coalesced, bounded query for the visible inspector. No parser worker or
 * expanded byte retention is needed for muted tracks. Closing/replacing the
 * inspected source invalidates in-flight results and cancels trailing retries. */
export function attachCachedTrackMetadata(source: MediaSource, peek: AudioPeek, demuxMetadata?: CachedTrackMetadata) {
  let enabled = false, disposed = false, generation = 0, last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let job: { ready: Promise<void>; finish(): void } | undefined;
  source.setMetadataInspectionEnabled = value => {
    if (enabled === value) return;
    enabled = value; generation++;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; job?.finish(); job = undefined; }
  };
  source.requestCachedMetadata = () => {
    if (!enabled || disposed) return Promise.resolve();
    if (job) return job.ready;
    const known = source.info.trackMetadata;
    if (known?.audio.complete && (known.container !== 'MPEG-TS' || known.audio.presence === 'absent' || known.audio.tracks.every(t => t.codec && t.channels && t.sampleRate))) return Promise.resolve();
    let finish!: () => void;
    const currentJob = { ready: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    job = currentJob;
    const delay = Math.max(0, 1000 - (performance.now() - last));
    const run = async () => {
      timer = undefined;
      last = performance.now(); const current = generation;
      try {
        const result = await (demuxMetadata ? structuredClone(demuxMetadata) : inspectCachedTracks(source.info.size, async (offset, length) => {
          if (!enabled || disposed || generation !== current) return;
          return peek(offset, length);
        }));
        if (!enabled || disposed || generation !== current) return;
        const previous = source.info.trackMetadata;
        // Cache eviction is not evidence that a previously identified track vanished.
        if (!result.container) result.container = previous?.container;
        if (!result.video || !result.audio.complete && previous?.video?.length) result.video = previous?.video ?? result.video;
        if (previous && !result.audio.complete && (result.audio.presence === 'unknown' || previous.audio.complete)) result.audio = previous.audio;
        updateMediaInfo(source, { trackMetadata: result }, 'cached-metadata');
      } finally {
        if (job === currentJob) job = undefined;
        currentJob.finish();
        if (enabled && !disposed && current !== generation) void source.requestCachedMetadata?.();
      }
    };
    // Do not insert a timer/paint between first selection and cached-header reads.
    if (delay > 0) timer = setTimeout(() => { void run(); }, delay);
    else void run();
    return currentJob.ready;
  };
  return () => { disposed = true; enabled = false; generation++; clearTimeout(timer); timer = undefined; job?.finish(); job = undefined; };
}
