import type { FrameDescription } from './frame-description.ts';

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
