/** HEVC SPS geometry (H.265 7.3.2.2, 7.4.3.2 and Annex E).
 * Bounded reads; no guessing from FLV metadata or scanning arbitrary NAL bytes. */
export interface HevcGeometry {
  codedWidth: number; codedHeight: number; x: number; y: number; width: number; height: number;
  sarNum: number; sarDen: number;
}
class Bits {
  private position = 0;
  private bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  read(n: number): number {
    if (n < 0 || n > 32 || this.position + n > this.bytes.length * 8) throw new Error('truncated SPS');
    let value = 0;
    while (n--) { value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1); this.position++; }
    return value;
  }
  skip(n: number) { while (n > 0) { const step = Math.min(n, 32); this.read(step); n -= step; } }
  ue(max = 0x7fffffff) {
    let zeros = 0;
    while (!this.read(1)) if (++zeros > 30) throw new Error('invalid Exp-Golomb');
    const value = 2 ** zeros - 1 + this.read(zeros);
    if (value > max) throw new Error('SPS value exceeds limit');
    return value;
  }
}
const ratios = [[1,1],[1,1],[12,11],[10,11],[16,11],[40,33],[24,11],[20,11],[32,11],[80,33],[18,11],[15,11],[64,33],[160,99],[4,3],[3,2],[2,1]];
export function parseHevcSpsGeometry(nal: Uint8Array): HevcGeometry {
  if (nal.length < 3 || nal[0] & 128 || ((nal[0] >> 1) & 63) !== 33 || !(nal[1] & 7)) throw new Error('invalid SPS NAL');
  const rbsp: number[] = [];
  for (let i = 2; i < nal.length; i++) {
    if (i >= 4 && nal[i] === 3 && nal[i-1] === 0 && nal[i-2] === 0 && i+1 < nal.length && nal[i+1] <= 3) continue;
    rbsp.push(nal[i]);
  }
  const b = new Bits(Uint8Array.from(rbsp));
  b.skip(4); const layers = b.read(3); if (layers > 6) throw new Error('invalid sublayers'); b.skip(1 + 96);
  const profiles: number[] = [], levels: number[] = [];
  for (let i = 0; i < layers; i++) { profiles.push(b.read(1)); levels.push(b.read(1)); }
  if (layers) b.skip((8-layers)*2);
  for (let i = 0; i < layers; i++) { if (profiles[i]) b.skip(88); if (levels[i]) b.skip(8); }
  b.ue(15); const chroma = b.ue(3), separate = chroma === 3 ? b.read(1) : 0;
  const codedWidth = b.ue(32768), codedHeight = b.ue(32768);
  const subX = !separate && (chroma === 1 || chroma === 2) ? 2 : 1, subY = !separate && chroma === 1 ? 2 : 1;
  let left = 0, right = 0, top = 0, bottom = 0;
  if (b.read(1)) { left = b.ue(32768)*subX; right = b.ue(32768)*subX; top = b.ue(32768)*subY; bottom = b.ue(32768)*subY; }
  const width = codedWidth-left-right, height = codedHeight-top-bottom;
  if (width <= 0 || height <= 0) throw new Error('invalid conformance window');
  b.ue(8); b.ue(8); const pocBits = b.ue(12)+4;
  const allOrdering = b.read(1);
  for (let i = allOrdering ? 0 : layers; i <= layers; i++) { b.ue(16); b.ue(16); b.ue(); }
  for (let i = 0; i < 6; i++) b.ue(32);
  if (b.read(1) && b.read(1)) {
    for (let size = 0; size < 4; size++) for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!b.read(1)) b.ue();
      else { if (size > 1) b.ue(); for (let j = 0; j < Math.min(64, 1 << (4 + 2*size)); j++) b.ue(); }
    }
  }
  b.skip(2);
  if (b.read(1)) { b.skip(8); b.ue(); b.ue(); b.skip(1); }
  const sets = b.ue(64), deltas: number[] = [];
  for (let i = 0; i < sets; i++) {
    if (i && b.read(1)) {
      b.skip(1); b.ue(); let count = 0;
      for (let j = 0; j <= deltas[i-1]; j++) { const used = b.read(1); if (used || b.read(1)) count++; }
      deltas.push(count);
    } else {
      const negative = b.ue(16), positive = b.ue(16); deltas.push(negative+positive);
      for (let j = 0; j < negative+positive; j++) { b.ue(); b.skip(1); }
    }
  }
  if (b.read(1)) { const count = b.ue(32); for (let i = 0; i < count; i++) b.skip(pocBits+1); }
  b.skip(2);
  let sarNum = 1, sarDen = 1;
  if (b.read(1) && b.read(1)) {
    const id = b.read(8);
    if (id === 255) { sarNum = b.read(16); sarDen = b.read(16); }
    else if (ratios[id]) [sarNum, sarDen] = ratios[id];
    else throw new Error('reserved aspect ratio');
  }
  if (!sarNum || !sarDen) throw new Error('invalid sample aspect ratio');
  return { codedWidth, codedHeight, x: left, y: top, width, height, sarNum, sarDen };
}
export function hevcGeometry(description: Uint8Array): HevcGeometry | null {
  try {
    if (description.length < 23 || description[0] !== 1) return null;
    let offset = 23;
    const u16 = () => { if (offset+2 > description.length) throw new Error('truncated hvcC'); const n = description[offset]*256+description[offset+1]; offset += 2; return n; };
    const geometries: HevcGeometry[] = [];
    for (let array = 0; array < description[22]; array++) {
      if (offset >= description.length) return null;
      const type = description[offset++] & 63, count = u16();
      for (let i = 0; i < count; i++) {
        const length = u16(); if (offset+length > description.length) return null;
        if (type === 33) geometries.push(parseHevcSpsGeometry(description.subarray(offset, offset+length)));
        offset += length;
      }
    }
    // Multiple simultaneously active SPS geometries need packet-level selection.
    return geometries.length && geometries.every(g => JSON.stringify(g) === JSON.stringify(geometries[0])) ? geometries[0] : null;
  } catch { return null; }
}

/** Never relabel a landscape pixel rectangle as portrait: lost/cropped pixels
 * cannot be repaired by changing canvas dimensions. */
export function verifyHevcFrame(frame: VideoFrame, geometry: HevcGeometry): VideoFrame {
  const rect = frame.visibleRect;
  if (!rect || rect.width !== geometry.width || rect.height !== geometry.height) {
    throw new Error(`HEVC 解码输出裁剪尺寸与 SPS 不一致：期望 ${geometry.width}×${geometry.height}，实际 coded=${frame.codedWidth}×${frame.codedHeight}, visible=${rect?.width}×${rect?.height}, display=${frame.displayWidth}×${frame.displayHeight}。`);
  }
  const displayWidth = Math.max(1, Math.round(geometry.width * geometry.sarNum / geometry.sarDen)), displayHeight = geometry.height;
  if (frame.displayWidth === displayWidth && frame.displayHeight === displayHeight) return frame;
  // The pixel rectangle was verified; only its display aspect needs correction.
  const corrected = new VideoFrame(frame, { displayWidth, displayHeight });
  frame.close();
  return corrected;
}
