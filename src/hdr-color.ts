import type { FrameDescription } from './frame-description.ts';
import { validateYuv, yuvSample, yuvReconstructedSample, visibleChromaBounds } from './yuv-color.ts';

export type HdrTransfer = 'pq' | 'hlg';
export type ColorTriple = readonly [number, number, number];

/** A versioned preview policy, not display calibration or a mastering transform.
 * Peaks are explicit assumptions until decoder metadata is available. */
export type HdrPreviewPolicy = {
  presentation: 'voidplayer-hdr-sdr-preview-v1';
  outputColorSpace: 'srgb';
  toneMap: 'extended-reinhard-luminance';
  gamutMap: 'desaturate-to-luminance';
  sourcePeakNits: number;
  exposureWhiteNits: number;
  hlgDisplayPeakNits: number;
  hlgSystemGamma: number;
};
export const HDR_PREVIEW_POLICY: Readonly<HdrPreviewPolicy> = Object.freeze({
  presentation: 'voidplayer-hdr-sdr-preview-v1', outputColorSpace: 'srgb',
  toneMap: 'extended-reinhard-luminance', gamutMap: 'desaturate-to-luminance',
  sourcePeakNits: 1000, exposureWhiteNits: 203, hlgDisplayPeakNits: 1000, hlgSystemGamma: 1.2,
});

export function hdrTransfer(transfer: string | null | undefined): HdrTransfer | null {
  if (transfer === 'pq' || transfer === 'smpte2084') return 'pq';
  if (transfer === 'hlg' || transfer === 'arib-std-b67') return 'hlg';
  return null;
}

export function validateHdrPreviewPolicy(p: Readonly<HdrPreviewPolicy>): void {
  if (p.presentation !== HDR_PREVIEW_POLICY.presentation || p.outputColorSpace !== 'srgb'
    || p.toneMap !== HDR_PREVIEW_POLICY.toneMap || p.gamutMap !== HDR_PREVIEW_POLICY.gamutMap
    || ![p.sourcePeakNits, p.exposureWhiteNits, p.hlgDisplayPeakNits, p.hlgSystemGamma].every(Number.isFinite)
    || p.exposureWhiteNits < 1 || p.sourcePeakNits < p.exposureWhiteNits || p.sourcePeakNits > 10000
    || p.hlgDisplayPeakNits < 1 || p.hlgDisplayPeakNits > 10000 || p.hlgSystemGamma < 1 || p.hlgSystemGamma > 2) {
    throw new Error('Unsupported HDR preview policy');
  }
}

/** Admit actual raw BT.2100 resources only. Container tags cannot turn an
 * already converted RGBA resource back into HDR, or fill missing raw tags. */
export function resolveHdrPreviewPlan(d: FrameDescription, policy: Readonly<HdrPreviewPolicy> = HDR_PREVIEW_POLICY) {
  validateHdrPreviewPolicy(policy);
  const transfer = hdrTransfer(d.color.transfer);
  const supported = !!d.yuv && [10, 12, 14, 16].includes(d.yuv.bitDepth) && transfer !== null
    && d.color.primaries === 'bt2020' && d.color.matrix === 'bt2020-ncl' && typeof d.color.fullRange === 'boolean';
  return { supported, transfer, policy: { ...policy }, target: 'srgb' as const };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const dot2020 = (c: ColorTriple) => c[0] * .2627 + c[1] * .6780 + c[2] * .0593;
const encodeSrgb = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;

/** ITU-R BT.2100 PQ EOTF, absolute cd/m² (black-level offset is zero). */
export function pqToNits(signal: number): number {
  if (!Number.isFinite(signal)) throw new Error('Invalid PQ signal');
  const n = clamp(signal) ** (32 / 2523);
  return 10000 * (Math.max(n - 3424 / 4096, 0) / (2413 / 128 - 2392 / 128 * n)) ** (16384 / 2610);
}

/** ITU-R BT.2100 HLG inverse OETF; this is scene light, not display nits. */
export function hlgToScene(signal: number): number {
  if (!Number.isFinite(signal)) throw new Error('Invalid HLG signal');
  const e = clamp(signal), a = .17883277, b = 1 - 4 * a, c = .5 - a * Math.log(4 * a);
  return e <= .5 ? e * e / 3 : (Math.exp((e - c) / a) + b) / 12;
}

/** BT.2020 display-linear RGB in nits. HLG OOTF depends on scene luminance,
 * never independently raises each channel to the system gamma. */
export function hdrToDisplayNits(rgb: ColorTriple, transfer: HdrTransfer, policy: Readonly<HdrPreviewPolicy> = HDR_PREVIEW_POLICY): [number, number, number] {
  validateHdrPreviewPolicy(policy);
  if (transfer !== 'pq' && transfer !== 'hlg') throw new Error('Unsupported HDR transfer');
  if (transfer === 'pq') return rgb.map(pqToNits) as [number, number, number];
  const scene = rgb.map(hlgToScene) as [number, number, number];
  const luminance = dot2020(scene);
  if (luminance <= 0) return [0, 0, 0];
  const gain = policy.hlgDisplayPeakNits * luminance ** (policy.hlgSystemGamma - 1);
  return scene.map(v => v * gain) as [number, number, number];
}

/** Linear luminance compression, then BT.2020→709 and a bounded chroma
 * compression toward the mapped neutral. No per-file RGB compensation. */
export function hdrToSdrPreview(rgb: ColorTriple, transfer: HdrTransfer, policy: Readonly<HdrPreviewPolicy> = HDR_PREVIEW_POLICY): [number, number, number] {
  const c = hdrToDisplayNits(rgb, transfer, policy), luminance = dot2020(c);
  if (luminance <= 0) return [0, 0, 0];
  const x = luminance / policy.exposureWhiteNits, peak = policy.sourcePeakNits / policy.exposureWhiteNits;
  const mapped = clamp(x * (1 + x / (peak * peak)) / (1 + x));
  const gain = mapped / luminance;
  const linear = [
    1.660491 * c[0] - .587641 * c[1] - .072850 * c[2],
    -.124550 * c[0] + 1.132900 * c[1] - .008349 * c[2],
    -.018151 * c[0] - .100579 * c[1] + 1.118730 * c[2],
  ].map(v => v * gain);
  let chroma = 1;
  for (const v of linear) {
    if (v > mapped) chroma = Math.min(chroma, (1 - mapped) / (v - mapped));
    if (v < mapped) chroma = Math.min(chroma, mapped / (mapped - v));
  }
  return linear.map(v => encodeSrgb(clamp(mapped + (v - mapped) * chroma))) as [number, number, number];
}

/** CPU reference for future presenter/capture integration. Existing SDR
 * admission and browser-managed rendering do not call this experimental API. */
export function hdrYuvToRgba(d: FrameDescription, pixels: Uint8Array | Uint8ClampedArray, policy: Readonly<HdrPreviewPolicy> = HDR_PREVIEW_POLICY): Uint8ClampedArray<ArrayBuffer> {
  if (!d.yuv) throw new Error('HDR preview requires raw YUV planes');
  validateYuv(d, pixels.byteLength);
  const plan = resolveHdrPreviewPlan(d, policy);
  if (!plan.supported || !plan.transfer) throw new Error('HDR preview requires explicitly tagged high-depth BT.2100 YUV');
  const l = d.yuv!, scale = 2 ** (l.bitDepth - 8), maximum = 2 ** l.bitDepth - 1;
  const full = d.color.fullRange, bounds = visibleChromaBounds(d);
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
    const sx = x + d.visibleRect.x, sy = y + d.visibleRect.y;
    const yy = (yuvSample(pixels, l, 0, sx, sy) - (full ? 0 : 16 * scale)) / (full ? maximum : 219 * scale);
    const cb = (yuvReconstructedSample(pixels, l, 1, sx, sy, bounds) - 128 * scale) / (full ? maximum : 224 * scale);
    const cr = (yuvReconstructedSample(pixels, l, 2, sx, sy, bounds) - 128 * scale) / (full ? maximum : 224 * scale);
    const rgb = hdrToSdrPreview([yy + 1.4746 * cr, yy - .16455312684365778 * cb - .5713531268436578 * cr, yy + 1.8814 * cb], plan.transfer, policy);
    const i = (y * d.width + x) * 4;
    out[i] = Math.round(rgb[0] * 255); out[i + 1] = Math.round(rgb[1] * 255); out[i + 2] = Math.round(rgb[2] * 255); out[i + 3] = 255;
  }
  return out;
}
