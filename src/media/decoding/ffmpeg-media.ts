// Compatibility entry point. Routing and concrete adapters have one-way dependencies.
export * from './ffmpeg-container-media.ts';
export * from './fallback-runtime.ts';
import type {MediaMeta,MediaSource} from '../contract.ts';
import type {FallbackDeps} from './fallback-runtime.ts';
export async function openFFmpegMediaFromUrl(url: string, meta: MediaMeta, deps: FallbackDeps = {}): Promise<MediaSource> {
  const { openSoftwareMedia } = await import('./software-media.ts');
  return openSoftwareMedia({ url, size: meta.size }, meta, deps);
}

