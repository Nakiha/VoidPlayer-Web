import type { FlvIndexDocument } from '../../../shared/media/indexing/flv-index-cache.ts';
import type { CachedPairSource, SourceBinding } from '../../../shared/analysis/quality/frame-pair.ts';

/** Internal prepared-cache boundary. The host attests that the immutable Blob and
 * cached document belong to binding; this adapter does not open a media library. */
export type PreparedPairSource = { binding: SourceBinding; file: Blob; index: FlvIndexDocument | null };
export function blobPairSource(prepared: PreparedPairSource): CachedPairSource {
  if (prepared.file.size !== prepared.binding.size) throw new Error('Prepared Blob size differs from source binding');
  const binding = structuredClone(prepared.binding);
  let closed = false;
  return { binding: () => structuredClone(binding), index: prepared.index,
    async read(offset, length) {
      if (closed) throw new Error('Prepared source closed');
      const bytes = new Uint8Array(await prepared.file.slice(offset, offset + length).arrayBuffer());
      if (closed) throw new Error('Prepared source closed');
      return bytes;
    }, close() { closed = true; } };
}
