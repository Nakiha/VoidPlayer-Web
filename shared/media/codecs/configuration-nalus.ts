import { isAnnexB, nalRanges } from './nal-framing.ts';
export type ConfigurationCodec = 'h264' | 'hevc' | 'vvc';
export interface NaluRecord { offset: number; size: number; type: number; temporalId: number; layer: number }
/** Sizes include the NAL header. Offsets are relative to the compressed AU,
 * after the length prefix or Annex-B start code. */
export function readNalus(codec: ConfigurationCodec, description: Uint8Array, bytes: Uint8Array): NaluRecord[] {
  return nalRanges(codec, description, bytes).map(({offset: at, size}) => {
    if (bytes[at] & 128 || (codec !== 'h264' && !(bytes[at + 1] & 7))) throw new Error('Invalid NAL header');
    return { offset: at, size,
      type: codec === 'h264' ? bytes[at] & 31 : codec === 'hevc' ? (bytes[at] >> 1) & 63 : bytes[at + 1] >> 3,
      temporalId: codec === 'h264' ? 0 : (bytes[at + 1] & 7) - 1,
      layer: codec === 'h264' ? 0 : codec === 'hevc' ? ((bytes[at] & 1) << 5) | (bytes[at + 1] >> 3) : bytes[at] & 63 };
  });
}
export interface ContainerHeader {
  box: 'avcC' | 'hvcC' | 'vvcC' | 'annexb'; byteLength: number; nalus: NaluRecord[];
}
/** Configuration NALs remain out of band; offsets are relative to the record,
 * sizes exclude its two-byte length fields. No payload is retained or injected. */
export function readContainerHeader(codec: ConfigurationCodec, description: Uint8Array): ContainerHeader {
  if (isAnnexB(description)) return {box: 'annexb', byteLength: description.length, nalus: readNalus(codec, description, description)};
  let at = 0;
  const take = (count: number) => { if (at + count > description.length) throw new Error('Truncated container configuration'); const start = at; at += count; return start; };
  const byte = () => description[take(1)];
  const word = () => (byte() << 8) | byte();
  const nalus: NaluRecord[] = [];
  const units = (count: number, expected: number) => {
    for (let i = 0; i < count; i++) {
      const size = word(), offset = take(size);
      if (size < (codec === 'h264' ? 1 : 2) || nalus.length >= 256) throw new Error('Invalid configuration NAL size/count');
      const type = codec === 'h264' ? description[offset] & 31 : codec === 'hevc' ? (description[offset] >> 1) & 63 : description[offset + 1] >> 3;
      if (type !== expected || description[offset] & 128 || codec !== 'h264' && !(description[offset + 1] & 7)) throw new Error('Invalid configuration NAL header');
      nalus.push({ offset, size, type, temporalId: codec === 'h264' ? 0 : (description[offset + 1] & 7) - 1,
        layer: codec === 'h264' ? 0 : codec === 'hevc' ? ((description[offset] & 1) << 5) | (description[offset + 1] >> 3) : description[offset] & 63 });
    }
  };
  if (description.length > 1024 * 1024) throw new Error('Container configuration budget exceeded');
  if (codec === 'h264') {
    if (byte() !== 1) throw new Error('Invalid avcC version');
    take(4); units(byte() & 31, 7); units(byte(), 8);
    // High-profile records may carry sequence parameter set extensions.
    if (at < description.length) { take(3); units(byte(), 13); }
  } else {
    let arrays: number;
    if (codec === 'hevc') { if (byte() !== 1) throw new Error('Invalid hvcC version'); take(21); arrays = byte(); }
    else {
      const flags = byte();
      if (flags & 1) {
        const sublayers = (word() >> 4) & 7; take(1);
        const constraints = byte() & 63; take(2 + Math.max(1, constraints));
        if (sublayers > 1) { const present = byte(); for (let i = 0; i < sublayers - 1; i++) if (present & (128 >> i)) take(1); }
        take(byte() * 4); take(6);
      }
      arrays = byte();
    }
    for (let i = 0; i < arrays; i++) {
      const type = byte() & (codec === 'hevc' ? 63 : 31);
      units(codec === 'vvc' && (type === 12 || type === 13) ? 1 : word(), type);
    }
  }
  if (at !== description.length) throw new Error('Trailing container configuration bytes');
  return { box: codec === 'h264' ? 'avcC' : codec === 'hevc' ? 'hvcC' : 'vvcC', byteLength: description.length, nalus };
}
