import { HDR_PREVIEW_POLICY, validateHdrPreviewPolicy } from './hdr-policy.ts';
import type { HdrPreviewPolicy } from './hdr-policy.ts';

export type ColorOutput = { target: 'sdr' | 'hdr'; hdrWhiteNits: number; preview: HdrPreviewPolicy };
const initial: ColorOutput = { target: 'sdr', hdrWhiteNits: 203, preview: { ...HDR_PREVIEW_POLICY } };
let current: ColorOutput = structuredClone(initial);
export const defaultColorOutput = (): ColorOutput => structuredClone(initial);
export const getColorOutput = (): ColorOutput => structuredClone(current);
export const getHdrPreviewPolicy = (): Readonly<HdrPreviewPolicy> => ({...current.preview});
export function validateColorOutput(value: ColorOutput) {
  if (!value || !['sdr', 'hdr'].includes(value.target) || !Number.isFinite(value.hdrWhiteNits) || value.hdrWhiteNits < 80 || value.hdrWhiteNits > 400)
    throw new Error('无效的显示目标或 HDR 参考白。');
  validateHdrPreviewPolicy(value.preview);
}
export function setColorOutput(value: ColorOutput) { validateColorOutput(value); current = structuredClone(value); }
export const hdrDisplayAvailable = () => typeof matchMedia !== 'undefined' && matchMedia('(dynamic-range: high)').matches;
