import { AnalysisFailure } from './failure.ts';

export const REFERENCE_EXPORTS = ['_vpa_reference_abi', '_vpa_ref_count', '_vpa_refs', '_vpa_refs_invalid', '_vpa_picture_type', '_vpa_poc'] as const;

/** The shipped analyzer requires both block and reference capabilities. */
export function validateAnalysisCore(core: Record<string, any>) {
  if (typeof core._vpa_abi !== 'function' || core._vpa_abi() !== 1 ||
      REFERENCE_EXPORTS.some(name => typeof core[name] !== 'function') || core._vpa_reference_abi() !== 1)
    throw new AnalysisFailure('internal-error', 'Analysis core ABI mismatch: block ABI 1 and reference ABI 1 are required');
  if (typeof core._vpa_feed_known !== 'function')
    throw new AnalysisFailure('internal-error', 'Analysis core ABI mismatch: known timestamp feed is required; update analysis assets to match the player build');
}
