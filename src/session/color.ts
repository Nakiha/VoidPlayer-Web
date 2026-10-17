import { getColorMode, getReferenceDecode } from '../color-mode.ts';
import { type ColorMode, type ReferenceDecode } from '../../shared/color/decode-policy-types.ts';
import { getColorOutput, validateColorOutput, type ColorOutput } from '../../shared/color/color-output.ts';
import type { ComparisonConditions } from '../../shared/review/workspace-file.ts';

export const currentColorEvidence = () =>
  getColorMode() === 'reference'
    ? (getColorOutput().target === 'hdr' ? 'reference-hdr-requested' : 'reference-sdr')
    : 'browser-match-approximate';

export function currentComparisonConditions(): ComparisonConditions {
  const output = getColorOutput();
  return {
    version: 2,
    colorMode: getColorMode() ?? 'browser',
    referenceDecode: getReferenceDecode(),
    presentation: 'voidplayer-color-v2',
    outputColorSpace: output.target === 'hdr' ? 'display-p3' : 'srgb',
    colorOutput: output,
  };
}

export function validateColorTransition(
  mode: ColorMode,
  decode: ReferenceDecode,
  output: ColorOutput,
  changingColor: boolean,
) {
  validateColorOutput(output);
  if (mode !== 'reference' && mode !== 'browser') throw new Error('未知色彩模式。');
  if (changingColor) throw new Error('正在切换色彩模式。');
  if (!['hardware', 'software'].includes(decode.decoder) || ![1, 2, 4, 8].includes(decode.depth)) {
    throw new Error('无效的解码路径或缓冲深度。');
  }
}

export function isSameColorConfiguration(mode: ColorMode, decode: ReferenceDecode, output: ColorOutput): boolean {
  return (
    getColorMode() === mode &&
    JSON.stringify(getReferenceDecode()) === JSON.stringify(decode) &&
    JSON.stringify(getColorOutput()) === JSON.stringify(output)
  );
}

export function persistColorConfiguration(mode: ColorMode, decode: ReferenceDecode, output: ColorOutput) {
  try {
    globalThis.localStorage?.setItem('voidplayer.color-mode', mode);
    globalThis.localStorage?.setItem('voidplayer.reference-decode', JSON.stringify(decode));
    globalThis.localStorage?.setItem('voidplayer.color-output', JSON.stringify(output));
  } catch {}
}
