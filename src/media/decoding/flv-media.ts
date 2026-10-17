import { openPacketMedia } from './packet-media.ts';
import type { FlvInput } from '../../../shared/media/containers/flv-demux.ts';
import type { MediaMeta } from '../source.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';

export function openFlvMedia(input: FlvInput, meta: MediaMeta, deps: FallbackDeps & { forceWasm?: boolean } = {}) {
  return openPacketMedia('flv', input, meta, deps);
}
