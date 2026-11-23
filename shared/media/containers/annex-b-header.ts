import type { AnnexBCodec } from '../codecs/annex-b-picture.ts';
import { isAnnexB } from '../codecs/nal-framing.ts';

/** Identify using parameter-set headers. An AUD or a slice alone is ambiguous. */
export function annexBCodec(bytes: Uint8Array): AnnexBCodec | undefined {
  if (!isAnnexB(bytes)) return;
  for (let i = 2; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 1 || bytes[i - 1] || bytes[i - 2]) continue;
    const a = bytes[i + 1], b = bytes[i + 2];
    if ((a & 0x9f) === 7 && a & 0x60) return 'h264';
    if ((a === 64 || a === 66) && b === 1) return 'hevc';
    if (a === 0 && (b === 113 || b === 121)) return 'vvc';
  }
}
