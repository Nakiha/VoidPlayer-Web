import { probeContainer } from './container-probe.ts';
import type { ContainerKind } from './container-probe.ts';
import type { RandomAccessInput } from './range-reader.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';
import type { MediaMeta, MediaSource } from './media.ts';
import { MediaOpenError } from './media-errors.ts';
import { loadAborted } from './media-abort.ts';
import { contextLog } from './log.ts';

/** One software adapter selection for local files, URLs and native witnesses.
 * Format adapters own demux/index only; color policy and presentation stay out. */
export async function openSoftwareMedia(input: RandomAccessInput, meta: MediaMeta, deps: FallbackDeps = {}, known?: ContainerKind): Promise<MediaSource> {
  const container = known ?? await probeContainer(input, deps.signal);
  if (container === 'flv' || container === 'isobmff') {
    const { openPacketMedia } = await import('./packet-media.ts');
    try { return await openPacketMedia(container === 'flv' ? 'flv' : 'mp4', input, meta, { ...deps, forceWasm: true }); }
    catch (error) {
      loadAborted(deps.signal);
      // FFmpeg deliberately has no FLV demuxer. An MP4 demux/codec gap can
      // select its container adapter; decode/input/resource failures cannot.
      if (container === 'flv' || !(error instanceof MediaOpenError) || !['container', 'codec'].includes(error.stage)) throw error;
      contextLog().info('media', 'MP4 压缩包路径不可用，使用 FFmpeg 解封装', { reason: error.message });
    }
  }
  const { openFFmpegMedia, openFFmpegContainerFromUrl } = await import('./ffmpeg-media.ts');
  return 'file' in input ? openFFmpegMedia(input.file as File, deps) : openFFmpegContainerFromUrl(input.url, meta, deps);
}
