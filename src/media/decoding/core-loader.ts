import {instantiateCore} from '../../../shared/wasm/core.ts';
import { coreAssetUrl } from './core-url.ts';
import type { MediaInfo } from '../../../shared/media/types.ts';

export function decoderConcurrency(
  core: { _vp_decoder_threads?(ctx: number): number; _vp_decoder_frame_contexts?(ctx: number): number },
  ctx: number,
): Pick<MediaInfo, 'decoderThreads' | 'decoderFrameContexts'> {
  const threads = core._vp_decoder_threads?.(ctx);
  const contexts = core._vp_decoder_frame_contexts?.(ctx);
  return {
    decoderThreads: typeof threads === 'number' && Number.isSafeInteger(threads) && threads > 0 ? threads : undefined,
    decoderFrameContexts: typeof contexts === 'number' && Number.isSafeInteger(contexts) && contexts > 0 ? contexts : undefined,
  };
}

export async function loadCore(glueURL: string, binary?: Uint8Array, maxMemoryBytes?: number, pthreadPoolSize?: number) {
  const mod = await import(/* @vite-ignore */ glueURL);
  if (!binary) {
    const url = new URL(glueURL); url.pathname = url.pathname.replace(/\.js$/, '.wasm');
    const response = await fetch(coreAssetUrl(url)); if (!response.ok) throw new Error(`WASM 下载失败：${response.status}`);
    binary = new Uint8Array(await response.arrayBuffer());
  }
  return instantiateCore(mod.default, binary, maxMemoryBytes, pthreadPoolSize);
}
