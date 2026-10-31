import { validateYuv, yuvSample, yuvReconstructedSample, visibleChromaBounds } from './yuv-planes.ts';
export { validateYuv, yuvSample, yuvReconstructedSample, visibleChromaBounds, chromaOffset } from './yuv-planes.ts';
export type { YuvLayout } from './yuv-planes.ts';
import type { ColorInfo } from '../review/model.ts';
import type { FrameDescription } from '../media/frame-description.ts';
import { hdrTransfer } from './hdr-policy.ts';
import { hdrToSdrPreview } from './hdr-color.ts';
import { getHdrPreviewPolicy } from './color-output.ts';

/** Display-referred SDR: preserve nonlinear signal values, with no 709 OETF
 * inversion. This is an explicit sRGB-like viewing convention, not scene-linear
 * colorimetry. Source tags are never mutated by these defaults. */
export function resolveYuvColor(d: FrameDescription) {
  const c = d.color;
  const matrix = c.matrix ?? (d.codedWidth >= 1280 || d.codedHeight > 576 ? 'bt709' : 'smpte170m');
  const fullRange = c.fullRange ?? !!d.sourcePixelFormat?.startsWith('yuvj');
  const primaries = c.primaries ?? (matrix === 'bt2020-ncl' ? 'bt2020' : matrix === 'bt709' ? 'bt709' : 'smpte170m');
  const transfer = c.transfer ?? 'bt709';
  const hdr = hdrTransfer(c.transfer);
  const supported = hdr
    ? c.matrix === 'bt2020-ncl' &&
      c.primaries === 'bt2020' &&
      typeof c.fullRange === 'boolean' &&
      (!d.yuv || [10, 12, 14, 16].includes(d.yuv.bitDepth))
    : ['bt709', 'smpte170m', 'bt470bg', 'bt2020-ncl'].includes(matrix) &&
      ['bt709', 'smpte170m', 'bt470bg', 'bt2020'].includes(primaries) &&
      ['bt709', 'smpte170m', 'iec61966-2-1', 'bt2020-10', 'bt2020-12'].includes(transfer);
  return {
    matrix,
    fullRange,
    primaries,
    transfer,
    supported,
    hdr,
    hdrPolicy: hdr ? getHdrPreviewPolicy() : null,
    provenance: Object.fromEntries(
      ['matrix', 'fullRange', 'primaries', 'transfer'].map((k) => [k, c[k as keyof ColorInfo] == null ? 'fallback' : 'resource']),
    ),
    target: 'srgb',
    sdrTransfer: 'display-referred-srgb-like',
    chromaSampling: 'bilinear-sited',
  };
}
export function yuvCoefficients(matrix: string): [number, number] {
  return matrix === 'bt709' ? [0.2126, 0.0722] : matrix === 'bt2020-ncl' ? [0.2627, 0.0593] : [0.299, 0.114];
}
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** Single source pixel through the shared range/matrix/transfer plan. */
export function yuvPixelRgb(
  d: FrameDescription,
  pixels: Uint8Array | Uint8ClampedArray,
  x: number,
  y: number,
  plan = resolveYuvColor(d),
): [number, number, number] {
  const l = d.yuv!;
  const [kr, kb] = yuvCoefficients(plan.matrix),
    kg = 1 - kr - kb;
  const scale = 2 ** (l.bitDepth - 8),
    max = 2 ** l.bitDepth - 1;
  const sx = x + d.visibleRect.x,
    sy = y + d.visibleRect.y;
  const yy = (yuvSample(pixels, l, 0, sx, sy) - (plan.fullRange ? 0 : 16 * scale)) / (plan.fullRange ? max : 219 * scale);
  const cb = (yuvReconstructedSample(pixels, l, 1, sx, sy, visibleChromaBounds(d)) - 128 * scale) / (plan.fullRange ? max : 224 * scale);
  const cr = (yuvReconstructedSample(pixels, l, 2, sx, sy, visibleChromaBounds(d)) - 128 * scale) / (plan.fullRange ? max : 224 * scale);
  let rgb = [yy + 2 * (1 - kr) * cr, yy - ((2 * kb * (1 - kb)) / kg) * cb - ((2 * kr * (1 - kr)) / kg) * cr, yy + 2 * (1 - kb) * cb];
  if (plan.hdr && plan.hdrPolicy) rgb = hdrToSdrPreview(rgb as [number, number, number], plan.hdr, plan.hdrPolicy);
  else if (plan.primaries === 'bt2020') {
    const [r, g, b] = rgb.map((v) => linear(Math.max(0, v)));
    rgb = [
      1.660491 * r - 0.587641 * g - 0.07285 * b,
      -0.12455 * r + 1.1329 * g - 0.008349 * b,
      -0.018151 * r - 0.100579 * g + 1.11873 * b,
    ].map(encoded);
  }
  return [
    Math.round(Math.max(0, Math.min(1, rgb[0])) * 255),
    Math.round(Math.max(0, Math.min(1, rgb[1])) * 255),
    Math.round(Math.max(0, Math.min(1, rgb[2])) * 255),
  ];
}
/** Isolated source channel as display gray, using the same range normalization
 * as the RGB path but no matrix/primaries conversion: Y maps normalized luma
 * 0–1 to black–white; U/V map normalized chroma (≈−0.5–0.5) shifted by +0.5
 * so neutral chroma renders mid-gray. Chroma keeps bilinear-sited
 * reconstruction; luma stays nearest. */
export function yuvChannelGray(
  d: FrameDescription,
  pixels: Uint8Array | Uint8ClampedArray,
  x: number,
  y: number,
  channel: 'y' | 'u' | 'v',
  plan = resolveYuvColor(d),
): [number, number, number] {
  const l = d.yuv!;
  const scale = 2 ** (l.bitDepth - 8),
    max = 2 ** l.bitDepth - 1;
  const sx = x + d.visibleRect.x,
    sy = y + d.visibleRect.y;
  let normalized: number;
  if (channel === 'y') {
    normalized = (yuvSample(pixels, l, 0, sx, sy) - (plan.fullRange ? 0 : 16 * scale)) / (plan.fullRange ? max : 219 * scale);
  } else {
    const component = channel === 'u' ? 1 : 2;
    normalized =
      (yuvReconstructedSample(pixels, l, component, sx, sy, visibleChromaBounds(d)) - 128 * scale) / (plan.fullRange ? max : 224 * scale) +
      0.5;
  }
  const gray = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
  return [gray, gray, gray];
}
/** Independent CPU reference and no-WebGL fallback. High depth stays intact
 * through range/matrix arithmetic, quantized only at final RGB output. Channel
 * 'y'/'u'/'v' isolates the source plane as gray without matrix conversion. */
export function yuvToRgba(
  d: FrameDescription,
  pixels: Uint8Array | Uint8ClampedArray,
  channel: 'rgb' | 'y' | 'u' | 'v' = 'rgb',
): Uint8ClampedArray<ArrayBuffer> {
  validateYuv(d, pixels.byteLength);
  const plan = resolveYuvColor(d);
  if (!plan.supported) throw new Error('Unsupported YUV color plan');
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++)
    for (let x = 0; x < d.width; x++) {
      const [r, g, b] = channel === 'rgb' ? yuvPixelRgb(d, pixels, x, y, plan) : yuvChannelGray(d, pixels, x, y, channel, plan);
      const i = (y * d.width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  return out;
}
