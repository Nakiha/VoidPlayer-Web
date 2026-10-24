import { validateDescription } from '../../media/frame-description.ts';
import type { FrameDescription } from '../../media/frame-description.ts';

export const PSNR_LIMITS = Object.freeze({ maxSamples: 16_777_216, maxInputBytes: 128 * 1024 * 1024, maxDimension: 16384 });
export type PsnrErrorCode = 'invalid-input' | 'unsupported-format' | 'missing-color' | 'incompatible-input' | 'budget-exceeded';
export class PsnrError extends Error {
  readonly code: PsnrErrorCode;
  readonly field: string;
  constructor(code: PsnrErrorCode, field: string) {
    super(`PSNR ${code}: ${field}`);
    this.name = 'PsnrError';
    this.code = code;
    this.field = field;
  }
}
export type PsnrFrame = { pixels: Uint8Array; description: FrameDescription };
export type PsnrRoi = { x: number; y: number; width: number; height: number };
export type PsnrRequest = {
  domain: 'source-yuv-code-values';
  reference: PsnrFrame;
  distorted: PsnrFrame;
  /** Mandatory, in the unrotated visible luma grid, with even x/y/width/height. */
  roi: PsnrRoi;
  budget?: { maxSamples?: number; maxInputBytes?: number };
};
export type PsnrValue = { kind: 'finite'; db: number } | { kind: 'positive-infinity'; db: null };
export type PsnrStatistics = { sse: number; samples: number; mse: number; psnr: PsnrValue };
export type PsnrColor = { primaries: string; transfer: string; matrix: string; fullRange: boolean; chromaLocation: number };
export type PsnrResult = {
  schema: 'voidplayer-source-plane-psnr'; version: 1; implementation: 'cpu-number-sse-v1';
  domain: 'source-yuv-code-values'; pairing: 'caller-supplied-unverified';
  geometry: 'unrotated-visible-pixel-grid'; roi: PsnrRoi;
  bitDepth: 8 | 10; peak: 255 | 1023; color: PsnrColor;
  planes: { y: PsnrStatistics; u: PsnrStatistics; v: PsnrStatistics }; aggregate: PsnrStatistics;
  work: { samples: number; bytesRead: number; inputViewBytes: number; chargedInputBytes: number };
};
const primaries = new Set(['bt709', 'smpte170m', 'bt470bg', 'bt2020']);
const transfers = new Set(['bt709', 'smpte170m', 'iec61966-2-1', 'bt2020-10', 'bt2020-12']);
const matrices = new Set(['bt709', 'smpte170m', 'bt470bg', 'bt2020-ncl']);
function fail(code: PsnrErrorCode, field: string): never { throw new PsnrError(code, field); }
function limit(value: number | undefined, hard: number, field: string) {
  if (value === undefined) return hard;
  if (!Number.isSafeInteger(value) || value < 1 || value > hard) fail('invalid-input', field);
  return value;
}
function inputBytes(frame: PsnrFrame, role: string) {
  if (!frame || !(frame.pixels instanceof Uint8Array) || !(frame.pixels.buffer instanceof ArrayBuffer))
    fail('invalid-input', `${role}.pixels`);
  // Shared/resizable storage cannot promise stable samples during a call.
  if ('resizable' in frame.pixels.buffer && frame.pixels.buffer.resizable) fail('unsupported-format', `${role}.pixels`);
  return frame.pixels.buffer.byteLength;
}
function frameColor(d: FrameDescription, role: string): PsnrColor {
  const c = d.color;
  if (!c || [c.primaries, c.transfer, c.matrix].some(v => v == null) || typeof c.fullRange !== 'boolean'
    || d.yuv!.chromaLocation == null || d.yuv!.chromaLocation === 0)
    fail('missing-color', `${role}.color`);
  if (!primaries.has(c.primaries!) || !transfers.has(c.transfer!) || !matrices.has(c.matrix!)
    || !Number.isInteger(d.yuv!.chromaLocation) || d.yuv!.chromaLocation! < 1 || d.yuv!.chromaLocation! > 6)
    fail('unsupported-format', `${role}.color`);
  return { primaries: c.primaries!, transfer: c.transfer!, matrix: c.matrix!, fullRange: c.fullRange, chromaLocation: d.yuv!.chromaLocation! };
}
function frameLayout(frame: PsnrFrame, role: string) {
  const d = frame.description;
  if (!d || typeof d !== 'object') fail('invalid-input', `${role}.description`);
  const l = d.yuv;
  if (d.format !== 'YUV' || !l || l.semiplanar !== false || l.subsampleX !== 1 || l.subsampleY !== 1
    || ![8, 10].includes(l.bitDepth) || l.bitShift !== 0 || d.byteLengthEstimated || d.colorFallback)
    fail('unsupported-format', `${role}.format`);
  try { validateDescription(d, frame.pixels.byteLength); } catch { fail('invalid-input', `${role}.layout`); }
  if (d.codedWidth > PSNR_LIMITS.maxDimension || d.codedHeight > PSNR_LIMITS.maxDimension)
    fail('budget-exceeded', `${role}.dimensions`);
  if ([d.codedWidth, d.codedHeight, d.width, d.height, d.visibleRect.x, d.visibleRect.y].some(n => n % 2))
    fail('unsupported-format', `${role}.chroma-alignment`);
  return { description: d, layout: l, color: frameColor(d, role) };
}
function statistics(sse: number, samples: number, peak: number): PsnrStatistics {
  const mse = sse / samples;
  return { sse, samples, mse, psnr: sse === 0 ? { kind: 'positive-infinity', db: null }
    : { kind: 'finite', db: 10 * Math.log10(peak * peak / mse) } };
}

/** Synchronous, bounded numeric kernel. Call from an independent executor, never a playback tick.
 * The caller owns stable source-plane buffers and is responsible for source/frame pairing.
 * No media access, alignment inference, range normalization, resampling or color conversion. */
export function measurePsnr(request: PsnrRequest): PsnrResult {
  if (!request || request.domain !== 'source-yuv-code-values') fail('unsupported-format', 'domain');
  const maxSamples = limit(request.budget?.maxSamples, PSNR_LIMITS.maxSamples, 'budget.maxSamples');
  const maxInputBytes = limit(request.budget?.maxInputBytes, PSNR_LIMITS.maxInputBytes, 'budget.maxInputBytes');
  // Charge entire retained backing allocations (conservatively twice when aliased).
  const chargedInputBytes = inputBytes(request.reference, 'reference') + inputBytes(request.distorted, 'distorted');
  if (chargedInputBytes > maxInputBytes) fail('budget-exceeded', 'inputBytes');
  const a = frameLayout(request.reference, 'reference'), b = frameLayout(request.distorted, 'distorted');
  if (a.layout.bitDepth !== b.layout.bitDepth || a.description.width !== b.description.width || a.description.height !== b.description.height
    || a.description.displayWidth !== b.description.displayWidth || a.description.displayHeight !== b.description.displayHeight
    || JSON.stringify(a.color) !== JSON.stringify(b.color)) fail('incompatible-input', 'pair.domain');
  const r = request.roi;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1
    || r.x + r.width > a.description.width || r.y + r.height > a.description.height)
    fail('invalid-input', 'roi');
  if ([r.x, r.y, r.width, r.height].some(n => n % 2)) fail('unsupported-format', 'roi.chroma-alignment');
  const samples = r.width * r.height * 3 / 2;
  if (samples > maxSamples) fail('budget-exceeded', 'samples');
  const bitDepth = a.layout.bitDepth as 8 | 10, peak = bitDepth === 8 ? 255 : 1023;
  const bytes = bitDepth === 8 ? 1 : 2, values: PsnrStatistics[] = [];
  let totalSse = 0;
  for (let component = 0; component < 3; component++) {
    const divisor = component ? 2 : 1, width = r.width / divisor, height = r.height / divisor;
    const ap = a.layout.planes[component], bp = b.layout.planes[component];
    const ax = (a.description.visibleRect.x + r.x) / divisor, ay = (a.description.visibleRect.y + r.y) / divisor;
    const bx = (b.description.visibleRect.x + r.x) / divisor, by = (b.description.visibleRect.y + r.y) / divisor;
    let sse = 0;
    for (let y = 0; y < height; y++) {
      let ai = ap.offset + (ay + y) * ap.stride + ax * bytes, bi = bp.offset + (by + y) * bp.stride + bx * bytes;
      for (let x = 0; x < width; x++, ai += bytes, bi += bytes) {
        const av = request.reference.pixels[ai] + (bytes === 2 ? request.reference.pixels[ai + 1] * 256 : 0);
        const bv = request.distorted.pixels[bi] + (bytes === 2 ? request.distorted.pixels[bi + 1] * 256 : 0);
        if (av > peak || bv > peak) fail('invalid-input', av > peak ? 'reference.sample' : 'distorted.sample');
        sse += (av - bv) ** 2;
      }
    }
    totalSse += sse;
    values.push(statistics(sse, width * height, peak));
  }
  return { schema: 'voidplayer-source-plane-psnr', version: 1, implementation: 'cpu-number-sse-v1', domain: request.domain,
    pairing: 'caller-supplied-unverified', geometry: 'unrotated-visible-pixel-grid', roi: { x: r.x, y: r.y, width: r.width, height: r.height },
    bitDepth, peak, color: { ...a.color }, planes: { y: values[0], u: values[1], v: values[2] }, aggregate: statistics(totalSse, samples, peak),
    work: { samples, bytesRead: samples * bytes * 2, inputViewBytes: request.reference.pixels.byteLength + request.distorted.pixels.byteLength, chargedInputBytes } };
}
