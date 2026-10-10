/** Lightweight AU evidence carried beside existing decoder input/output.
 * No IO, decoder, pixel access or analysis collector. Unverified layouts fail closed. */
export interface PacketPicture { au: number; configuration: number; stream: string; }
export function inspectPacketPicture(codec: string, description: Uint8Array, bytes: Uint8Array): { singlePicture: boolean; closedRandomAccess: boolean; reason?: string } {
  const fail = (reason: string) => ({ singlePicture: false, closedRandomAccess: false, reason });
  const lengthSize = codec === 'h264' ? ((description[4] ?? 0) & 3) + 1 : codec === 'hevc' ? ((description[21] ?? 0) & 3) + 1 : codec === 'vvc' ? ((description[0] ?? 0) & 3) + 1 : 0;
  if (!lengthSize || !bytes.length) return fail('unsupported-codec');
  let at = 0, pictures = 0, vcl = 0, closed = false;
  while (at < bytes.length) {
    if (at + lengthSize > bytes.length) return fail('truncated-nal');
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + bytes[at++];
    if (!length || at + length > bytes.length) return fail('truncated-nal');
    const start = at; at += length;
    if (codec === 'h264') {
      const type = bytes[start] & 31;
      if (bytes[start] & 128 || [2,3,4,14,20,21].includes(type)) return fail('unsupported-avc-picture-layout');
      if (type === 1 || type === 5) {
        if (length < 2) return fail('truncated-slice');
        // first_mb_in_slice ue(v) == 0 iff its first bit is 1.
        if (bytes[start + 1] & 128) pictures++;
        vcl++; closed ||= type === 5;
      }
    } else {
      if (length < 2 || bytes[start] & 128 || !(bytes[start+1] & 7)) return fail('invalid-nal-header');
      const type = codec === 'hevc' ? (bytes[start] >> 1) & 63 : bytes[start+1] >> 3;
      const layer = codec === 'hevc' ? ((bytes[start] & 1) << 5) | (bytes[start+1] >> 3) : bytes[start] & 63;
      if (layer) return fail('unsupported-layer');
      if (type < (codec === 'hevc' ? 32 : 12)) {
        if (length < 3) return fail('truncated-slice');
        vcl++;
        if (codec === 'hevc' && bytes[start+2] & 128) pictures++;
        closed ||= codec === 'hevc' ? type === 19 || type === 20 : type === 7 || type === 8;
      }
    }
  }
  if (codec === 'vvc') pictures = vcl; // MVP explicitly admits single-slice VVC only.
  return pictures === 1 && vcl > 0 ? { singlePicture: true, closedRandomAccess: closed } : fail('ambiguous-au');
}
