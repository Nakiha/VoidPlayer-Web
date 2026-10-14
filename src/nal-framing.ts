/** Bounded NAL framing iterator shared by picture admission and diagrams.
 * An Annex-B configuration remains Annex-B; no avcC is fabricated. */
export function isAnnexB(bytes: Uint8Array) {
  if (bytes.length < 3 || bytes[0] !== 0 || bytes[1] !== 0) return false;
  let at = 2;
  while (at < bytes.length && bytes[at] === 0) at++;
  return bytes[at] === 1; // Legal leading_zero_8bits precede the start code.
}
export function nalRanges(codec: string, description: Uint8Array, bytes: Uint8Array) {
  const output: {offset: number; size: number}[] = [];
  const add = (offset: number, size: number) => {
    if (size < (codec === 'h264' ? 1 : 2) || output.length >= 4096) throw new Error('Invalid NAL size/count');
    output.push({offset, size});
  };
  if ((codec === 'h264' || codec === 'hevc') && isAnnexB(description)) {
    const prefix = (i: number) => bytes[i] === 0 && bytes[i+1] === 0 ? bytes[i+2] === 1 ? 3 : bytes[i+2] === 0 && bytes[i+3] === 1 ? 4 : 0 : 0;
    let at = 0;
    while (at < bytes.length && !prefix(at)) { if (bytes[at++]) throw new Error('Invalid Annex-B prefix'); }
    if (at === bytes.length) throw new Error('Missing Annex-B NAL');
    while (at < bytes.length) {
      const start = at + prefix(at); let end = start;
      while (end < bytes.length && !prefix(end)) end++;
      let last = end; while (last > start && bytes[last-1] === 0) last--;
      add(start, last-start); at = end;
    }
  } else {
    const lengthSize = ((description[codec === 'h264' ? 4 : codec === 'hevc' ? 21 : 0] ?? 0) & 3) + 1;
    for (let at = 0; at < bytes.length;) {
      if (at+lengthSize > bytes.length) throw new Error('Truncated NAL length');
      let size = 0; for (let i=0; i<lengthSize; i++) size=size*256+bytes[at++];
      if (!size || at+size > bytes.length) throw new Error('Truncated NAL payload');
      add(at, size); at+=size;
    }
  }
  return output;
}
