import { measureFlvFramePair } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import { openPairDecoder } from './wasm-decoder.ts';
import { blobPairSource } from './source.ts';
import type { PreparedPairSource } from './source.ts';
import { coreAssetUrl } from '../../media/decoding/core-url.ts';
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(data: unknown): void };
scope.onmessage = async ({ data }: MessageEvent<{ request: FramePairRequest; sources: [PreparedPairSource, PreparedPairSource]; base: string }>) => {
  scope.onmessage = null; // One request per Worker; the owner terminates on every terminal path.
  try {
    const sources = data.sources.map(blobPairSource) as ReturnType<typeof blobPairSource>[];
    const result = await measureFlvFramePair(data.request, [sources[0], sources[1]],
      budget => openPairDecoder(coreAssetUrl('vendor/voidplayer-core/voidplayer-core.js', data.base), undefined, budget.maxHeapBytes), new AbortController().signal);
    scope.postMessage({ ok: true, result });
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error),
      field: error && typeof error === 'object' && 'field' in error ? error.field : undefined,
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'decoder-error' });
  }
};
