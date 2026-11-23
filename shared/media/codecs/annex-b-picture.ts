import { parseAvcSequence } from './avc-geometry.ts';
import { vvcSps } from './coding-features.ts';
import { hevcAnnexBSequence } from './hevc-geometry.ts';
import { vvcSequenceTiming } from './vvc-timing.ts';
import { nalPayload } from './parameter-bits.ts';

export type AnnexBCodec = 'h264' | 'hevc' | 'vvc';
export interface AnnexBPicture { poc: number; key: boolean; reset: boolean; leading: boolean; }

export function annexBNalType(codec: AnnexBCodec, bytes: Uint8Array) {
  if (bytes.length < (codec === 'h264' ? 1 : 2) || bytes[0] & 128) throw Error('invalid NAL header');
  if (codec === 'h264') return bytes[0] & 31;
  if (!(bytes[1] & 7) || (codec === 'hevc' ? bytes[0] & 1 || bytes[1] >> 3 : bytes[0]))
    throw Error('multilayer or invalid NAL header');
  return codec === 'hevc' ? bytes[0] >> 1 : bytes[1] >> 3;
}

export const annexBParameterTypes = { h264: [7, 8], hevc: [32, 33, 34], vvc: [14, 15, 16] };
export const annexBPrefixTypes = {
  h264: [6, 7, 8, 9], hevc: [32, 33, 34, 35, 39], vvc: [12, 13, 14, 15, 16, 17, 19, 20, 23],
};

function unwrappedPoc(lsb: number, previous: number, bits: number) {
  const modulus = 2 ** bits;
  const prevLsb = ((previous % modulus) + modulus) % modulus;
  let msb = previous - prevLsb;
  if (lsb < prevLsb && prevLsb - lsb >= modulus / 2) msb += modulus;
  if (lsb > prevLsb && lsb - prevLsb > modulus / 2) msb -= modulus;
  return msb + lsb;
}

class AvcPictures {
  private sps?: ReturnType<typeof parseAvcSequence>;
  private pps?: { id: number; spsId: number; bottomPresent: boolean };
  private previousPoc = 0;
  private previousFrame = 0;
  private frameOffset = 0;
  private header?: string;
  get frameRate() { return this.sps?.frameRate; }

  parameter(type: number, nal: Uint8Array) {
    if (type === 7) {
      this.sps = parseAvcSequence(nal);
      if (this.sps.geometry.interlaced || this.sps.separate) throw Error('unsupported AVC field or separate-plane coding');
    } else {
      const b = nalPayload(nal, 1);
      const id = b.ue(255), spsId = b.ue(31);
      b.skip(1);
      this.pps = { id, spsId, bottomPresent: !!b.read(1) };
      if (b.ue(7)) throw Error('unsupported AVC slice groups');
    }
  }

  picture(type: number, nal: Uint8Array, hasPicture: boolean): AnnexBPicture | undefined {
    if (type !== 1 && type !== 5) {
      if (type >= 2 && type <= 4 || type >= 14 && type <= 31) throw Error('unsupported AVC NAL type');
      return;
    }
    const { sps, pps } = this;
    if (!sps || !pps || pps.spsId !== sps.id) throw Error('missing AVC parameter sets');
    const b = nalPayload(nal, 1), key = type === 5, ref = !!(nal[0] & 0x60);
    const firstMb = b.ue();
    b.ue(9);
    if (b.ue(255) !== pps.id) throw Error('unknown AVC PPS');
    const frame = b.read(sps.frameNumBits), idrId = key ? b.ue(65535) : -1;
    let lsb = 0, delta = 0, deltaBottom = 0;
    if (sps.pocType === 0) {
      lsb = b.read(sps.pocBits);
      if (pps.bottomPresent) deltaBottom = b.se();
    } else if (sps.pocType === 1 && !sps.deltaAlwaysZero) {
      delta = b.se();
      if (pps.bottomPresent) deltaBottom = b.se();
    }
    const header = [key, ref, frame, idrId, lsb, delta, deltaBottom].join(',');
    if (hasPicture && this.header === header && firstMb !== 0) return;
    if (firstMb !== 0) throw Error('missing first AVC slice');
    this.header = header;
    let poc: number;
    if (sps.pocType === 0) {
      const top = key ? lsb : unwrappedPoc(lsb, this.previousPoc, sps.pocBits);
      if (ref) this.previousPoc = top;
      poc = top + Math.min(0, deltaBottom);
    } else {
      if (key) this.frameOffset = 0;
      else if (frame < this.previousFrame) this.frameOffset += 2 ** sps.frameNumBits;
      const absolute = this.frameOffset + frame;
      this.previousFrame = frame;
      if (sps.pocType === 2) poc = key ? 0 : 2 * absolute - Number(!ref);
      else {
        const offsets = sps.referenceOffsets, n = offsets.length;
        const count = n ? Math.max(0, absolute - Number(!ref)) : 0;
        const expected = count ? Math.floor((count - 1) / n) * offsets.reduce((a, v) => a + v, 0)
          + offsets.slice(0, (count - 1) % n + 1).reduce((a, v) => a + v, 0) : 0;
        poc = expected + (ref ? 0 : sps.nonRefOffset) + delta + Math.min(0, sps.topToBottomOffset + deltaBottom);
      }
    }
    return { poc, key, reset: key, leading: false };
  }
}

class HevcPictures {
  private sps?: ReturnType<typeof hevcAnnexBSequence>;
  private pps?: { id: number; spsId: number; output: boolean; extra: number };
  private previousPoc?: number;
  get frameRate() { return this.sps?.frameRate; }

  parameter(type: number, nal: Uint8Array) {
    if (type === 33) {
      this.sps = hevcAnnexBSequence(nal);
      if (this.sps.interlaced || this.sps.separate) throw Error('unsupported HEVC field or separate-plane coding');
    } else if (type === 34) {
      const b = nalPayload(nal, 2);
      const id = b.ue(63), spsId = b.ue(15);
      b.skip(1);
      this.pps = { id, spsId, output: !!b.read(1), extra: b.read(3) };
    }
  }

  picture(type: number, nal: Uint8Array, hasPicture: boolean): AnnexBPicture | undefined {
    if (type > 31) return;
    if (type > 9 && (type < 16 || type > 21)) throw Error('unsupported HEVC picture type');
    const b = nalPayload(nal, 2), first = b.read(1);
    if (!first) {
      if (!hasPicture) throw Error('missing first HEVC slice');
      return;
    }
    const { pps, sps } = this;
    const key = type >= 16, reset = type <= 20 && key, idr = type === 19 || type === 20, leading = type >= 6 && type <= 9;
    if (key) b.skip(1);
    if (!sps || !pps || sps.id !== pps.spsId || b.ue(63) !== pps.id) throw Error('missing HEVC parameter sets');
    b.skip(pps.extra);
    b.ue(2);
    if (pps.output && !b.read(1)) throw Error('non-output HEVC picture');
    const lsb = idr ? 0 : b.read(sps.pocBits);
    const poc = reset || this.previousPoc === undefined ? lsb : unwrappedPoc(lsb, this.previousPoc, sps.pocBits);
    if ((nal[1] & 7) === 1 && !leading && ![0, 2, 4].includes(type)) this.previousPoc = poc;
    return { poc, key, reset, leading };
  }
}

class VvcPictures {
  private sps?: { id: number; bits: number; cycleBits: number; extra: number };
  private pps?: { id: number; spsId: number };
  private header?: { lsb: number; nonRef: boolean; msb?: number };
  private previousPoc?: number;
  frameRate?: number;

  parameter(type: number, nal: Uint8Array) {
    const b = nalPayload(nal, 2);
    if (type === 15) {
      const sequence = vvcSps(b), bits = b.read(4) + 4;
      if (bits > 16) throw Error('invalid VVC POC width');
      const cycleBits = b.read(1) ? b.ue(27 - bits) + 1 : 0;
      const length = b.read(2) * 8;
      let extra = 0;
      for (let i = 0; i < length; i++) extra += b.read(1);
      const timing = vvcSequenceTiming(b, sequence, bits);
      if (timing.interlaced) throw Error('unsupported VVC field coding');
      this.frameRate = timing.frameRate;
      this.sps = { id: sequence.id, bits, cycleBits, extra };
    } else if (type === 16) this.pps = { id: b.read(6), spsId: b.read(4) };
  }

  picture(type: number, nal: Uint8Array, hasPicture: boolean): AnnexBPicture | undefined {
    if (type !== 19 && type > 11) {
      if (type === 12 || type === 13) throw Error('unsupported VVC operating point');
      return;
    }
    if (type >= 4 && type <= 6 || type >= 10 && type <= 11) throw Error('unsupported VVC picture type');
    const b = nalPayload(nal, 2);
    if (type === 19 || b.read(1)) {
      const { sps, pps } = this;
      const irap = b.read(1), nonRef = !!b.read(1);
      if (irap && b.read(1)) throw Error('VVC gradual decoder refresh is unsupported');
      if (b.read(1)) b.skip(1);
      if (!sps || !pps || pps.spsId !== sps.id || b.ue(63) !== pps.id) throw Error('missing VVC parameter sets');
      const lsb = b.read(sps.bits);
      b.skip(sps.extra);
      const msb = sps.cycleBits && b.read(1) ? b.read(sps.cycleBits) * 2 ** sps.bits : undefined;
      this.header = { lsb, nonRef, msb };
    } else if (hasPicture) return;
    if (type === 19) return;
    const header = this.header;
    if (!header) throw Error('missing VVC picture header');
    this.header = undefined;
    const reset = type === 7 || type === 8, leading = type === 2 || type === 3;
    const poc = header.msb !== undefined ? header.msb + header.lsb : reset || this.previousPoc === undefined ? header.lsb
      : unwrappedPoc(header.lsb, this.previousPoc, this.sps!.bits);
    if ((nal[1] & 7) === 1 && !header.nonRef && !leading) this.previousPoc = poc;
    return { poc, key: reset || type === 9, reset, leading };
  }
}

export function annexBPictures(codec: AnnexBCodec) {
  if (codec === 'h264') return new AvcPictures();
  if (codec === 'hevc') return new HevcPictures();
  return new VvcPictures();
}
