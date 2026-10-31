import { canonicalJson } from '../../../shared/analysis/quality/correspondence.ts';
import type { TemporalPrepared, TemporalPlanSnapshot } from '../../../shared/analysis/quality/temporal-contract.ts';
import { qualityEvidenceValue } from '../../../shared/review/quality-evidence.ts';

/** Post-admission facts only. Each metric retains sequence, cadence and pixel-domain admission. */
export function validatePreparedFacts(
  value: TemporalPrepared, snapshot: TemporalPlanSnapshot,
  input: { metrics: { ssim: boolean }; budget: { maxRawBytes: number } },
  resultBytes: number, error: (code: string, message: string) => Error,
) {
  if (
    value.pairs.length !== value.sequence.pairs.length ||
    value.raw.bytes !== value.geometry.width * value.geometry.height * 3 / 2 *
      (value.geometry.bitDepth === 8 ? 1 : 2) * value.pairs.length * 2 ||
    [value.raw.referenceSha256, value.raw.distortedSha256].some(h => !/^[a-f0-9]{64}$/.test(h))
  ) throw error('worker-result-invalid', 'Prepared raw frame count/geometry differs');
  for (const [index, pair] of value.pairs.entries()) {
    qualityEvidenceValue(pair);
    const expected = value.sequence.pairs[index];
    if (
      canonicalJson(pair.result.metric.roi) !== canonicalJson(expected.roi) ||
      pair.result.metric.bitDepth !== value.geometry.bitDepth || !!pair.result.ssim !== input.metrics.ssim
    ) throw error('worker-result-invalid', 'Prepared metric recipe changed');
    for (const side of ['reference', 'distorted'] as const) {
      const p = pair.result.provenance[side], e = expected[side];
      for (const field of ['mediaId', 'mediaVersion', 'size', 'indexIdentity', 'indexBuildId', 'sourcePtsUs', 'picture', 'decode'] as const)
        if (canonicalJson(p[field]) !== canonicalJson(e[field]))
          throw error('worker-result-invalid', 'Prepared source/picture identity changed');
    }
  }
  const budget = snapshot.value.rangePlan!.input.budget;
  if (
    value.work.readBytes > budget.maxReadBytes || value.work.packets > budget.maxPackets ||
    value.work.outputFrames > budget.maxOutputFrames || value.work.inputBytes > budget.maxInputBytes
  ) throw error('worker-result-invalid', 'Prepared work exceeds frozen total budget');
  if (value.raw.bytes > input.budget.maxRawBytes || Buffer.byteLength(JSON.stringify(value)) > resultBytes)
    throw error('budget-exceeded', 'Prepared sequence result budget exceeded');
}
