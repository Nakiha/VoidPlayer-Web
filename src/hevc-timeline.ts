import type { Mp4Configurations } from './mp4-config.ts';
import type { RangeReader } from './range-reader.ts';

/** A deliberately bounded H.265 7.3.6 / 8.3.1 reader. Only single-layer,
 * progressive Main/Main10, closed IDR GOPs with one output picture per sample
 * are eligible. POC establishes picture order, never the original wall clock. */
class Bits {
  private at = 0;
  private data: Uint8Array;
  constructor(data: Uint8Array) { this.data = data; }
  read(n: number): number {
    if (n < 0 || n > 32 || this.at + n > this.data.length * 8) throw Error('truncated HEVC header');
    let v = 0;
    while (n--) { v = v * 2 + ((this.data[this.at >> 3] >> (7 - (this.at & 7))) & 1); this.at++; }
    return v;
  }
  skip(n: number) { while (n > 0) { const step = Math.min(n, 32); this.read(step); n -= step; } }
  ue(max = 65535): number {
    let n = 0;
    while (!this.read(1)) if (++n > 16) throw Error('HEVC header value exceeds limit');
    const v = 2 ** n - 1 + this.read(n);
    if (v > max) throw Error('HEVC header value exceeds limit');
    return v;
  }
}
function rbsp(nal: Uint8Array) {
  const out: number[] = [];
  for (let i = 2; i < nal.length; i++) {
    if (i >= 4 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && i + 1 < nal.length && nal[i + 1] <= 3) continue;
    out.push(nal[i]);
  }
  return new Bits(Uint8Array.from(out));
}
function nalType(nal: Uint8Array) {
  if (nal.length < 2 || nal[0] & 128 || !(nal[1] & 7) || (nal[0] & 1) || (nal[1] >> 3)) throw Error('unsupported HEVC layer');
  return (nal[0] >> 1) & 63;
}
function parameterSets(description: Uint8Array) {
  if (description.length < 23 || description[0] !== 1) throw Error('invalid hvcC');
  const sets: Uint8Array[] = [];
  let at = 23;
  const u16 = () => {
    if (at + 2 > description.length) throw Error('truncated hvcC');
    const n = description[at] * 256 + description[at + 1]; at += 2; return n;
  };
  for (let i = 0; i < description[22]; i++) {
    if (at >= description.length) throw Error('truncated hvcC');
    const type = description[at++] & 63, count = u16();
    for (let j = 0; j < count; j++) {
      const length = u16();
      if (length < 2 || at + length > description.length) throw Error('truncated hvcC NAL');
      const nal = description.slice(at, at + length); at += length;
      if (nalType(nal) !== type) throw Error('hvcC type mismatch');
      sets.push(nal);
    }
  }
  if (at !== description.length) throw Error('unsupported hvcC extension');
  return { sets, lengthSize: (description[21] & 3) + 1 };
}
function spsHeader(nal: Uint8Array) {
  const b = rbsp(nal);
  b.skip(4); const layers = b.read(3); if (layers > 6) throw Error('invalid sublayers'); b.skip(1);
  const space = b.read(2); b.skip(1); const profile = b.read(5); b.skip(32);
  const progressive = b.read(1), interlaced = b.read(1); b.skip(46 + 8);
  if (space || ![1, 2].includes(profile) || !progressive || interlaced) throw Error('unsupported HEVC picture structure');
  const profiles: number[] = [], levels: number[] = [];
  for (let i = 0; i < layers; i++) { profiles.push(b.read(1)); levels.push(b.read(1)); }
  if (layers) b.skip((8 - layers) * 2);
  for (let i = 0; i < layers; i++) { if (profiles[i]) b.skip(88); if (levels[i]) b.skip(8); }
  const id = b.ue(15), chroma = b.ue(3);
  if (chroma !== 1) throw Error('unsupported HEVC chroma');
  b.ue(32768); b.ue(32768);
  if (b.read(1)) for (let i = 0; i < 4; i++) b.ue(32768);
  b.ue(8); b.ue(8);
  const pocBits = b.ue(12) + 4, allOrdering = b.read(1);
  let maxReorder = 0;
  for (let i = allOrdering ? 0 : layers; i <= layers; i++) {
    const buffering = b.ue(16), reorder = b.ue(16); b.ue();
    if (reorder > buffering) throw Error('invalid HEVC reorder bound');
    maxReorder = Math.max(maxReorder, reorder);
  }
  return { id, pocBits, maxReorder };
}
function ppsHeader(nal: Uint8Array) {
  const b = rbsp(nal), id = b.ue(63), sps = b.ue(15);
  b.skip(1); // dependent_slice_segments_enabled_flag: first slice is independent
  return { id, sps, outputFlag: b.read(1), extraBits: b.read(3) };
}

/** Pure picture header state, exported for bit-level boundary tests. */
export class HevcPictureOrder {
  readonly lengthSize: number;
  private sets: Uint8Array[];
  private sps: ReturnType<typeof spsHeader>;
  private pps: ReturnType<typeof ppsHeader>;
  private previousTid0 = 0;
  get canReorder() { return this.sps.maxReorder > 0; }
  constructor(description: Uint8Array) {
    const { sets, lengthSize } = parameterSets(description);
    this.sets = sets; this.lengthSize = lengthSize;
    const sps = sets.filter(n => nalType(n) === 33), pps = sets.filter(n => nalType(n) === 34);
    if (sps.length !== 1 || pps.length !== 1) throw Error('multiple HEVC parameter sets');
    this.sps = spsHeader(sps[0]); this.pps = ppsHeader(pps[0]);
    if (this.pps.sps !== this.sps.id) throw Error('unknown SPS');
  }
  parameterSet(nal: Uint8Array) {
    // Annex-B trailing_zero_8bits may have been retained in hvcC by a muxer.
    const unpad = (n: Uint8Array) => { let end = n.length; while (end > 2 && n[end - 1] === 0) end--; return n.subarray(0, end); };
    const actual = unpad(nal);
    if (!this.sets.some(s => { const expected = unpad(s); return expected.length === actual.length && expected.every((v, i) => v === actual[i]); })) throw Error('in-band HEVC configuration change');
  }
  picture(nal: Uint8Array): { poc: number; idr: boolean } | null {
    const type = nalType(nal), tid = (nal[1] & 7) - 1;
    if (type > 31) return null;
    const idr = type === 19 || type === 20;
    if (type > 5 && !idr) throw Error('open GOP or unsupported HEVC picture');
    const b = rbsp(nal);
    if (!b.read(1)) return null; // remaining slices share the first slice POC
    if (idr) b.skip(1);
    if (b.ue(63) !== this.pps.id) throw Error('unknown PPS');
    b.skip(this.pps.extraBits);
    const slice = b.ue(2);
    if (idr && (slice !== 2 || tid !== 0)) throw Error('invalid IDR picture');
    if (this.pps.outputFlag && !b.read(1)) throw Error('non-output HEVC picture');
    let poc = 0;
    if (!idr) {
      const max = 2 ** this.sps.pocBits, lsb = b.read(this.sps.pocBits);
      const prevLsb = ((this.previousTid0 % max) + max) % max;
      let msb = this.previousTid0 - prevLsb;
      if (lsb < prevLsb && prevLsb - lsb >= max / 2) msb += max;
      else if (lsb > prevLsb && lsb - prevLsb > max / 2) msb -= max;
      poc = msb + lsb;
    }
    // H.265 8.3.1: sub-layer non-reference pictures do not advance prevTid0.
    if (tid === 0 && ![0, 2, 4].includes(type)) this.previousTid0 = poc;
    return { poc, idr };
  }
}

/** Return a complete decode-index permutation only when every closed GOP has
 * unique contiguous POCs and the container omitted all composition offsets.
 * Unsupported syntax leaves existing routing intact; IO failures still throw. */
export async function hevcDisplayOrder(reader: Pick<RangeReader, 'read'>, configs: Mp4Configurations,
  progress?: () => void): Promise<number[] | null> {
  const { sampleOffsets: offsets, sampleSizes: sizes, compositionOffsets: ctts } = configs;
  if (configs.descriptions.length !== 1 || !offsets?.length || !sizes || !ctts || ctts.some(n => n !== 0)) return null;
  let parser: HevcPictureOrder;
  try { parser = new HevcPictureOrder(configs.descriptions[0]); } catch { return null; }
  // Low-delay streams with a zero SPS reorder bound need no payload scan.
  if (!parser.canReorder) return null;
  const order: number[] = [], group: { poc: number; index: number }[] = [];
  const finish = () => {
    group.sort((a, b) => a.poc - b.poc);
    if (group.some((p, i) => p.poc !== i)) throw Error('incomplete HEVC GOP');
    for (const p of group) order.push(p.index);
    group.length = 0;
  };
  for (let i = 0; i < offsets.length; i++) {
    if (i % 64 === 0) progress?.();
    let at = offsets[i], end = at + sizes[i], picture: ReturnType<HevcPictureOrder['picture']> = null;
    let nals = 0;
    while (at < end) {
      if (++nals > 1024 || end - at < parser.lengthSize + 2) return null;
      const head = await reader.read(at, parser.lengthSize + 2);
      let length = 0;
      for (let j = 0; j < parser.lengthSize; j++) length = length * 256 + head[j];
      at += parser.lengthSize;
      if (length < 2 || at + length > end) return null;
      try { nalType(head.subarray(parser.lengthSize)); } catch { return null; }
      const type = (head[parser.lengthSize] >> 1) & 63;
      // Skip large SEI payloads and coded slice data without materializing them.
      const bytes = type <= 31 ? Math.min(length, 64) : [32, 33, 34].includes(type) ? length : 0;
      if (bytes > 65536) return null;
      const nal = bytes ? await reader.read(at, bytes) : undefined;
      try {
        if (type <= 31) { const next = parser.picture(nal!); if (next) { if (picture) return null; picture = next; } }
        else if (nal) parser.parameterSet(nal);
      } catch { return null; }
      at += length;
    }
    if (!picture || (!i && !picture.idr)) return null;
    try { if (picture.idr && group.length) finish(); } catch { return null; }
    group.push({ poc: picture.poc, index: i });
  }
  try { finish(); } catch { return null; }
  return order.some((p, i) => p !== i) ? order : null;
}

/** Reuse declared constant cadence, including rounding and the original start.
 * Do not invent a CFR clock for a VFR stream or conceal duplicate timestamps. */
export function recoveredHevcTimes(order: number[], timestamps: number[], durations: number[]): number[] | null {
  if (order.length !== timestamps.length || durations.length !== timestamps.length || timestamps.length < 2) return null;
  const step = (timestamps.at(-1)! - timestamps[0]) / (timestamps.length - 1);
  if (!(step >= 1000 && step <= 1000000)) return null;
  if (timestamps.some((t, i) => !Number.isSafeInteger(t) || Math.abs(t - timestamps[0] - i * step) > 2 ||
    Math.abs(durations[i] - step) > 2 || (i > 0 && t <= timestamps[i - 1]))) return null;
  const result = new Array<number>(order.length), seen = new Set<number>();
  for (let rank = 0; rank < order.length; rank++) {
    const packet = order[rank];
    if (!Number.isInteger(packet) || packet < 0 || packet >= order.length || seen.has(packet)) return null;
    seen.add(packet); result[packet] = timestamps[rank];
  }
  return result;
}
