import { parseAvcSpsDetails } from './avc-geometry.ts';
import { readContainerHeader, type ContainerHeader } from './configuration-nalus.ts';
import { hevcSpsFeatures } from './hevc-geometry.ts';
import { ParameterBits } from './parameter-bits.ts';

export interface ParameterSetFeatures {
  kind: 'SPS' | 'PPS'; layer: number; id: number; spsId?: number;
  profileIdc?: number; levelIdc?: number; profileSpace?: number; highTier?: boolean;
  codedWidth?: number; codedHeight?: number; lumaBitDepth?: number; chromaFormatIdc?: number; ctuSize?: number; maxReferenceFrames?: number;
  frameMbsOnly?: boolean; maxReorderFrames?: number; entropyCoding?: 'CABAC' | 'CAVLC';
  wavefront?: boolean; tileColumns?: number; tileRows?: number; entryPointOffsets?: boolean;
}
export interface CodingFeatures {
  scope: 'initial-configuration'; format: ContainerHeader['box']; parameterSets: ParameterSetFeatures[];
  unreadableParameterSets: number;
  firstPacket?: { sourcePtsUs: number; configuration: number; vclNalUnits: number };
}

function payload(nal: Uint8Array, header: number) {
  const bytes = [];
  for (let i = header; i < nal.length; i++) {
    if (i >= header + 2 && !nal[i-2] && !nal[i-1] && nal[i] === 3 && nal[i+1] <= 3) continue;
    bytes.push(nal[i]);
  }
  // rbsp_stop_one_bit and its padding cannot supply a missing syntax flag.
  let last = bytes.length - 1;
  while (last >= 0 && !bytes[last]) last--;
  if (last < 0) throw Error('Missing RBSP trailing bits');
  const trailingZeros = 31 - Math.clz32(bytes[last] & -bytes[last]);
  return new ParameterBits(Uint8Array.from(bytes), last * 8 + 7 - trailingZeros);
}

function hevcPps(b: ParameterBits) {
  const id = b.ue(63), spsId = b.ue(15);
  b.skip(7); b.ue(14); b.ue(14); b.ue(); // flags, default refs, init QP
  b.skip(2); if (b.read(1)) b.ue(); // CU QP delta depth
  b.ue(); b.ue(); b.skip(4); // chroma offsets, prediction and bypass flags
  const tiles = b.read(1), wavefront = !!b.read(1);
  return { id, spsId, wavefront, tileColumns: tiles ? b.ue(19) + 1 : 1, tileRows: tiles ? b.ue(21) + 1 : 1 };
}

function readVvcProfile(b: ParameterBits, sublayers: number) {
  const profileIdc = b.read(7), highTier = !!b.read(1), levelIdc = b.read(8);
  b.skip(2); // frame-only and multilayer constraints
  if (b.read(1)) { b.skip(71); b.skip(b.read(8)); }
  b.align();
  let levels = 0;
  for (let i = 0; i < sublayers; i++) levels += b.read(1);
  b.align(); b.skip(levels * 8);
  b.skip(b.read(8) * 32);
  return {profileIdc, highTier, levelIdc};
}
function skipVvcSubpictures(b: ParameterBits, columns: number, rows: number) {
  const count = b.ue(999) + 1;
  if (count > 1) {
    const independent = b.read(1), sameSize = b.read(1);
    const positionBits = Math.ceil(Math.log2(columns)) + Math.ceil(Math.log2(rows));
    for (let i = 0; i < count; i++) {
      if (!sameSize || i === 0) {
        if (i > 0) b.skip(positionBits);
        if (i < count - 1) b.skip(positionBits);
      }
      if (!independent) b.skip(2);
    }
  }
  const idBits = b.ue(15) + 1;
  if (b.read(1) && b.read(1)) b.skip(count * idBits);
}
function vvcSps(b: ParameterBits) {
  const id = b.read(4); b.skip(4);
  const sublayers = b.read(3), chromaFormatIdc = b.read(2), ctuSize = 2 ** (5 + b.read(2));
  const profile = b.read(1) ? readVvcProfile(b, sublayers) : undefined;
  b.skip(1); if (b.read(1)) b.skip(1); // GDR and reference picture resampling
  const width = b.ue(65535), height = b.ue(65535);
  if (!width || !height || ctuSize > 128) throw Error('Invalid VVC picture geometry');
  if (b.read(1)) for (let i = 0; i < 4; i++) b.ue();
  if (b.read(1)) skipVvcSubpictures(b, Math.ceil(width / ctuSize), Math.ceil(height / ctuSize));
  return { id, ...profile, chromaFormatIdc, ctuSize, lumaBitDepth: 8 + b.ue(8), wavefront: !!b.read(1), entryPointOffsets: !!b.read(1) };
}
function tileCount(b: ParameterBits, explicit: number, remaining: number, max: number) {
  let size = 0;
  for (let i = 0; i < explicit; i++) { size = b.ue(remaining - 1) + 1; remaining -= size; }
  // VVC repeats the last explicit tile size up to the picture boundary.
  const count = explicit + Math.ceil(remaining / size);
  if (count > max) throw Error('Invalid VVC tile grid');
  return count;
}
function vvcPps(b: ParameterBits) {
  const id = b.read(6), spsId = b.read(4); b.skip(1);
  const width = b.ue(65535), height = b.ue(65535);
  if (!width || !height) throw Error('Invalid VVC PPS geometry');
  for (let window = 0; window < 2; window++) if (b.read(1)) for (let i = 0; i < 4; i++) b.ue();
  b.skip(1);
  if (b.read(1)) return { id, spsId, codedWidth: width, codedHeight: height, tileColumns: 1, tileRows: 1 };
  if (b.read(1)) { const count = b.ue(999) + 1, bits = b.ue(15) + 1; b.skip(count * bits); }
  const ctu = 2 ** (5 + b.read(2)), columns = b.ue(29) + 1, rows = b.ue(989) + 1;
  const tileColumns = tileCount(b, columns, Math.ceil(width / ctu), 30), tileRows = tileCount(b, rows, Math.ceil(height / ctu), 990);
  if (ctu > 128 || tileColumns * tileRows > 990) throw Error('Invalid VVC tile geometry');
  return { id, spsId, codedWidth: width, codedHeight: height, tileColumns, tileRows };
}

/** Configuration snapshot only. Per-picture slice layout and in-band switches need AU evidence. */
export function readCodingFeatures(codec: string, description: Uint8Array, firstPacket?: CodingFeatures['firstPacket']): CodingFeatures | undefined {
  codec = codec.split('.', 1)[0];
  if (codec === 'avc1' || codec === 'avc3') codec = 'h264';
  if (codec === 'hvc1' || codec === 'hev1') codec = 'hevc';
  if (codec === 'vvc1' || codec === 'vvi1') codec = 'vvc';
  if ((codec !== 'h264' && codec !== 'hevc' && codec !== 'vvc') || !description.length || description.length > 1024 * 1024) return;
  let header: ContainerHeader;
  try { header = readContainerHeader(codec, description); } catch { return; }
  const spsType = codec === 'h264' ? 7 : codec === 'hevc' ? 33 : 15;
  const sets = header.nalus.filter(n => n.type === spsType || n.type === spsType + 1);
  const report: CodingFeatures = { scope: 'initial-configuration', format: header.box, parameterSets: [], unreadableParameterSets: 0 };
  for (const [i, n] of sets.entries()) {
    if (i >= 32 || n.size > 65535) { report.unreadableParameterSets++; continue; }
    const nal = description.subarray(n.offset, n.offset + n.size), kind = n.type === spsType ? 'SPS' : 'PPS';
    try {
      let fields: Omit<ParameterSetFeatures, 'kind' | 'layer'>;
      if (codec === 'h264' && kind === 'SPS') {
        const { geometry, ...details } = parseAvcSpsDetails(nal);
        fields = { ...details, codedWidth: geometry.codedWidth, codedHeight: geometry.codedHeight, frameMbsOnly: !geometry.interlaced, ...(geometry.maxReorderFrames === null ? {} : {maxReorderFrames: geometry.maxReorderFrames}) };
      } else if (codec === 'h264') {
        const b = payload(nal, 1);
        fields = { id: b.ue(255), spsId: b.ue(31), entropyCoding: b.read(1) ? 'CABAC' : 'CAVLC' };
      } else if (codec === 'hevc') fields = kind === 'SPS' ? hevcSpsFeatures(nal) : hevcPps(payload(nal, 2));
      else fields = kind === 'SPS' ? vvcSps(payload(nal, 2)) : vvcPps(payload(nal, 2));
      report.parameterSets.push({ kind, layer: n.layer, ...fields });
    } catch { report.unreadableParameterSets++; }
  }
  if (firstPacket) report.firstPacket = firstPacket;
  return report;
}

/** Use picture dimensions from one unambiguous base-layer SPS/PPS pair. VVC carries them in the PPS. */
export function configuredPicturePixels(features?: CodingFeatures): number {
  if (!features || features.unreadableParameterSets || features.parameterSets.length !== 2) return 0;
  const sps = features.parameterSets.find(p => p.kind === 'SPS'), pps = features.parameterSets.find(p => p.kind === 'PPS');
  if (!sps || !pps || sps.layer || pps.layer || sps.id !== pps.spsId) return 0;
  const size = features.format === 'vvcC' ? pps : sps;
  return (size.codedWidth ?? 0) * (size.codedHeight ?? 0);
}
