import { resolveYuvColor } from './yuv-color.ts';
import type { FrameDescription } from './frame-description.ts';

/** HDR transfer identities shared by policy, GPU admission and UI tags.
 * Canonical resources use 'pq'/'hlg'; the 'smpte2084'/'arib-std-b67' spellings
 * are tolerated because ffprobe and some browser color spaces use them. */
export const isHdrTransfer = (transfer: string | null | undefined) =>
  transfer === 'pq' || transfer === 'hlg' || transfer === 'smpte2084' || transfer === 'arib-std-b67';

/** Color policy uses the delivered resource, never relabels it from the source.
 * See docs/color-pipeline.md before adding any new conversion. */
export function presentationColor(kind: 'video-sample' | 'rgba8' | 'yuv', description: FrameDescription) {
  const hdr = isHdrTransfer(description.color.transfer);
  const sourceHdr = isHdrTransfer(description.sourceColor?.transfer);
  const canvasConversion = kind === 'video-sample' && hdr;
  const unsupportedHdr = kind === 'rgba8' && (hdr || sourceHdr);
  return { color: description.color, sourceColor: description.sourceColor ?? null, hdr, sourceHdr,
    format: description.format, opaque: kind === 'video-sample' && description.format === null,
    byteLengthEstimated: description.byteLengthEstimated ?? false,
    plan: kind === 'yuv' ? resolveYuvColor(description) : null, fallback: description.colorFallback ?? null,
    target: 'srgb', canvasConversion, unsupportedHdr,
    conversion: kind === 'yuv' ? 'unified-yuv-sdr' : canvasConversion ? 'canvas2d-srgb' : unsupportedHdr ? 'rgba8-hdr-unmanaged' : kind === 'rgba8' ? 'rgba8-upload' : 'browser-default' };
}
