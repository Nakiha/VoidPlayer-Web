export const MAX_ANALYSIS_THREADS = 4;
export type AnalysisDecoderSettings = { threads: number; contexts: number };

export function decoderForCodec(codec: string, budget: number, manual?: AnalysisDecoderSettings): AnalysisDecoderSettings {
  const family = codec.split('.', 1)[0].toLowerCase();
  if (['h264', 'avc', 'avc1', 'avc3'].includes(family)) {
    const threads = manual?.contexts ?? Math.min(budget, MAX_ANALYSIS_THREADS);
    return { threads, contexts: threads };
  }
  if (['hevc', 'h265', 'hev1', 'hvc1'].includes(family)) return { threads: manual?.threads ?? Math.min(budget, 2), contexts: 1 };
  if (['h266', 'vvc', 'vvc1', 'vvi1'].includes(family)) {
    const threads = Math.min(budget, 2);
    return manual ?? { threads, contexts: threads };
  }
  return { threads: 1, contexts: 1 };
}
