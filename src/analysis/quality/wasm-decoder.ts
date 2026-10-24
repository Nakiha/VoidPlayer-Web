import { createPairDecoder } from '../../../shared/analysis/quality/wasm-decoder.ts';
import { PAIR_LIMITS } from '../../../shared/analysis/quality/frame-pair.ts';
import { loadCore } from '../../media/decoding/core-loader.ts';
export function openPairDecoder(glueURL: string, binary?: Uint8Array, maxMemoryBytes = PAIR_LIMITS.maxHeapBytes as number) {
  return createPairDecoder(() => loadCore(glueURL, binary, maxMemoryBytes));
}
