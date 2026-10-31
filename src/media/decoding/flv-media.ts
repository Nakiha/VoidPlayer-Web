import { openPacketMedia } from './packet-media.ts';
import type { FlvInput } from '../../../shared/media/containers/flv-demux.ts';
import type { MediaMeta } from '../contract.ts';
import type { FallbackDeps } from './ffmpeg-media.ts';

export function openFlvMedia(input: FlvInput, meta: MediaMeta, deps: FallbackDeps & { forceWasm?: boolean; nativePresentedLibrary?:import('../../../shared/media/io/library-reference-types.ts').LibraryIndexReference } = {}) {
  return openPacketMedia('flv', input, meta, deps);
}
