import { openPacketMedia } from './packet-media.ts';
import type { FlvInput } from './flv-demux.ts';
import type { MediaMeta } from './media.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';

export function openFlvMedia(input: FlvInput, meta: MediaMeta, deps: FallbackDeps & { forceWasm?: boolean } = {}) {
  return openPacketMedia('flv', input, meta, deps);
}
