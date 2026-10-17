import { isAnnexB, nalRanges } from './nal-framing.ts';
/** Lightweight AU evidence carried beside existing decoder input/output.
 * No IO, decoder, pixel access or analysis collector. Unverified layouts fail closed. */
export interface PacketPicture {
  au: number;
  configuration: number;
  stream: string;
}
export function inspectPacketPicture(
  codec: string,
  description: Uint8Array,
  bytes: Uint8Array,
): { singlePicture: boolean; closedRandomAccess: boolean; reason?: string } {
  const fail = (reason: string) => ({
    singlePicture: false,
    closedRandomAccess: false,
    reason,
  });
  if(codec==='vp8') {
    if(bytes.length<3 || !(bytes[0]&16))return fail('unsupported-hidden-vp8-picture');
    const key=!(bytes[0]&1);
    if(key&&(bytes.length<10||bytes[3]!==0x9d||bytes[4]!==1||bytes[5]!==0x2a))return fail('invalid-vp8-key');
    return {singlePicture:true,closedRandomAccess:key};
  }
  if(codec==='vp9') {
    if(bytes.length<2)return fail('truncated-vp9-header');
    // VP9 superframes can emit multiple pictures. Do not assign one AU identity
    // to them, or to hidden/show-existing frames, without a verified mapping.
    const marker=bytes.at(-1)!,frames=(marker&7)+1,indexBytes=2+frames*((marker>>3&3)+1);
    if((marker&0xe0)===0xc0&&bytes.length>=indexBytes&&bytes[bytes.length-indexBytes]===marker&&frames>1)return fail('unsupported-vp9-superframe');
    let bit=0;const read=()=>{if(bit>=bytes.length*8)throw new Error('truncated VP9');return bytes[bit>>3]>>(7-(bit++&7))&1;};
    if((read()<<1|read())!==2)return fail('invalid-vp9-marker');
    const low=read(),profile=low|(read()<<1);if(profile===3&&read())return fail('invalid-vp9-profile');
    if(read())return fail('unsupported-vp9-show-existing');
    const key=read()===0;if(!read())return fail('unsupported-hidden-vp9-picture');
    return {singlePicture:true,closedRandomAccess:key};
  }
  if (!['h264','hevc','vvc'].includes(codec) || !bytes.length) return fail('unsupported-codec');
  let ranges: ReturnType<typeof nalRanges>;
  try { ranges = nalRanges(codec, description, bytes); } catch { return fail('truncated-nal'); }
  let pictures = 0, vcl = 0, closed = false;
  for (const {offset: start, size: length} of ranges) {
    if (codec === "h264") {
      const type = bytes[start] & 31;
      if (bytes[start] & 128 || [2, 3, 4, 14, 20, 21].includes(type))
        return fail("unsupported-avc-picture-layout");
      if (type === 1 || type === 5) {
        if (length < 2) return fail("truncated-slice");
        // first_mb_in_slice ue(v) == 0 iff its first bit is 1.
        if (bytes[start + 1] & 128) pictures++;
        vcl++;
        closed ||= type === 5;
      }
    } else {
      if (length < 2 || bytes[start] & 128 || !(bytes[start + 1] & 7))
        return fail("invalid-nal-header");
      const type =
        codec === "hevc" ? (bytes[start] >> 1) & 63 : bytes[start + 1] >> 3;
      const layer =
        codec === "hevc"
          ? ((bytes[start] & 1) << 5) | (bytes[start + 1] >> 3)
          : bytes[start] & 63;
      if (layer) return fail("unsupported-layer");
      if (type < (codec === "hevc" ? 32 : 12)) {
        if (length < 3) return fail("truncated-slice");
        vcl++;
        if (codec === "hevc" && bytes[start + 2] & 128) pictures++;
        closed ||=
          codec === "hevc"
            ? type === 19 || type === 20
            : type === 7 || type === 8;
      }
    }
  }
  if (codec === "vvc") pictures = vcl; // MVP explicitly admits single-slice VVC only.
  if (codec === 'h264' && isAnnexB(description) && vcl !== 1) return fail('unsupported-ts-multiple-slices');
  return pictures === 1 && vcl > 0
    ? { singlePicture: true, closedRandomAccess: closed }
    : fail("ambiguous-au");
}
