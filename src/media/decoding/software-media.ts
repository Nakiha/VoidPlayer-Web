import { probeContainer } from '../policy/container-probe.ts';
import type { ContainerKind } from '../policy/container-probe.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import type { FallbackDeps } from './fallback-runtime.ts';
import type { MediaMeta, MediaSource } from '../contract.ts';

/** One software adapter selection for local files, URLs and native witnesses.
 * Format adapters own demux/index only; color policy and presentation stay out. */
export async function openSoftwareMedia(input: RandomAccessInput, meta: MediaMeta, deps: FallbackDeps = {}, known?: ContainerKind): Promise<MediaSource> {
  const container = known ?? await probeContainer(input, deps.signal);
  if (container === 'flv' || container === 'isobmff') {
    const { openPacketMedia } = await import('./packet-media.ts');
    return openPacketMedia(container === 'flv' ? 'flv' : 'mp4', input, meta, { ...deps, forceWasm: true });
  }
  const { openFFmpegMedia, openFFmpegContainerFromUrl } = await import('./ffmpeg-container-media.ts');
  return 'file' in input ? openFFmpegMedia(input.file as File, deps) : openFFmpegContainerFromUrl(input.url, meta, deps);
}
