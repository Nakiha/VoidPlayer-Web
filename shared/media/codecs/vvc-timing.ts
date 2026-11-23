import type { ParameterBits } from './parameter-bits.ts';
import type { vvcSps } from './coding-features.ts';

function skipPartitionLimits(bits: ParameterBits) {
  bits.ue(6);
  if (bits.ue(12)) { bits.ue(6); bits.ue(6); }
}

function skipReferenceLists(bits: ParameterBits, lists: number, longTerm: boolean, weighted: boolean, pocBits: number) {
  for (let list = 0; list < lists; list++) {
    const count = bits.ue(64);
    for (let i = 0; i < count; i++) {
      const entries = bits.ue(29);
      const longTermInHeader = longTerm && entries > 0 && !!bits.read(1);
      for (let entry = 0; entry < entries; entry++) {
        if (!longTerm || bits.read(1)) {
          const delta = bits.ue(32767);
          if (delta || !weighted || !entry) bits.skip(1);
        } else if (!longTermInHeader) bits.skip(pocBits);
      }
    }
  }
}

/** Read SPS timing from the highest coded temporal sublayer (H.266 7.3.2.3). */
export function vvcSequenceTiming(b: ParameterBits, sps: ReturnType<typeof vvcSps>, pocBits: number) {
  const { vpsId, sublayers, chromaFormatIdc: chroma, ctuSize, profileIdc } = sps;
  const hasPtl = profileIdc !== undefined;
  b.skip(b.read(2) * 8); // extra slice header flags
  if (hasPtl) {
    const all = sublayers > 0 && b.read(1);
    for (let layer = all ? 0 : sublayers; layer <= sublayers; layer++) {
      b.ue(16); b.ue(16); b.ue();
    }
  }
  b.ue(4);
  b.skip(1); // partition constraints override
  skipPartitionLimits(b);
  if (chroma && b.read(1)) skipPartitionLimits(b);
  skipPartitionLimits(b);

  const transform64 = ctuSize > 32 && b.read(1);
  const transformSkip = b.read(1);
  if (transformSkip) { b.ue(3); b.skip(1); }
  if (b.read(1)) b.skip(2); // explicit MTS modes
  const lfnst = b.read(1);
  if (chroma) {
    const joint = b.read(1), tables = b.read(1) ? 1 : joint ? 3 : 2;
    for (let table = 0; table < tables; table++) {
      b.se();
      const points = b.ue(127) + 1;
      for (let i = 0; i < points; i++) { b.ue(255); b.ue(255); }
    }
  }

  b.skip(1); // SAO
  if (b.read(1) && chroma) b.skip(1); // ALF / CCALF
  b.skip(1); // LMCS
  const weightedPred = b.read(1), weightedBipred = b.read(1), longTerm = !!b.read(1);
  if (vpsId && b.read(1)) throw Error('unsupported VVC inter-layer references');
  b.skip(1); // IDR carries reference lists
  skipReferenceLists(b, b.read(1) ? 1 : 2, longTerm, !!(weightedPred || weightedBipred), pocBits);

  b.skip(1); // reference wraparound
  if (b.read(1)) b.skip(1); // subblock temporal MVP
  const amvr = b.read(1);
  if (b.read(1)) b.skip(1); // BDOF picture control
  b.skip(1); // SMVD
  if (b.read(1)) b.skip(1); // DMVR picture control
  if (b.read(1)) b.skip(1); // MMVD full-pel restriction
  const mergeCandidates = 6 - b.ue(5);
  b.skip(1); // subblock transform
  if (b.read(1)) {
    b.ue(5);
    b.skip(amvr ? 2 : 1); // six-parameter affine and optional affine AMVR
    if (b.read(1)) b.skip(1); // PROF picture control
  }
  b.skip(2); // BCW and CIIP
  if (mergeCandidates >= 2 && b.read(1) && mergeCandidates >= 3) b.ue(4);
  b.ue(6);
  b.skip(3); // ISP, MRL and MIP
  if (chroma) b.skip(chroma === 1 ? 3 : 1); // CCLM and optional chroma sample location
  const palette = b.read(1);
  const act = chroma === 3 && !transform64 && b.read(1);
  if (transformSkip || palette) b.ue(8);
  if (b.read(1)) b.ue(5); // intra block copy
  if (b.read(1)) {
    const intervals = b.read(2) + 1;
    b.se();
    for (let i = 0; i < intervals; i++) { b.se(); b.ue(); }
  }
  if (b.read(1)) {
    if (lfnst) b.skip(1);
    if (act && b.read(1)) b.skip(1);
  }
  b.skip(2); // dependent quantization and sign hiding
  if (b.read(1) && b.read(1)) {
    for (let axis = 0; axis < 2; axis++) {
      const boundaries = b.ue(3);
      for (let i = 0; i < boundaries; i++) b.ue(8192);
    }
  }
  const frameRate = hasPtl && b.read(1) ? fixedVvcFrameRate(b, sublayers) : undefined;
  return { frameRate, interlaced: !!b.read(1) };
}

function fixedVvcFrameRate(b: ParameterBits, sublayers: number) {
  const units = b.read(32), scale = b.read(32), nal = b.read(1), vcl = b.read(1);
  let du = 0, cpbCount = 1;
  if (nal || vcl) {
    b.skip(1);
    du = b.read(1);
    b.skip(du ? 20 : 8);
    cpbCount = b.ue(31) + 1;
  }
  const allLayers = sublayers > 0 && b.read(1);
  let ticks = 0;
  for (let layer = allLayers ? 0 : sublayers; layer <= sublayers; layer++) {
    ticks = b.read(1) || b.read(1) ? b.ue(2047) + 1 : 0;
    if (!ticks && (nal || vcl) && cpbCount === 1) b.skip(1);
    const entries = (nal + vcl) * cpbCount;
    for (let i = 0; i < entries; i++) {
      for (let field = 0; field < (du ? 4 : 2); field++) b.ue();
      b.skip(1);
    }
  }
  return units && ticks ? scale / (units * ticks) : undefined;
}
