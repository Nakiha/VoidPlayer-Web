import type { AnalysisQuery, AnalysisResult, AnalysisSample } from './types.ts';
import type { SourceQueryContext } from './adapters.ts';

export interface NativeAnalysisCommands {
  append: { input: { records: Float64Array }; output: number };
  query: { input: { context: SourceQueryContext; query: Omit<AnalysisQuery, 'signal'> & { requestId: number } }; output: AnalysisResult };
  locate: { input: { mediaId: string; firstPtsUs: number; sampleId: string }; output: AnalysisSample | null };
  rank: { input: { firstPtsUs: number; axis: 'pts' | 'dts'; tUs: number }; output: { rank: number; total: number; ordinal: number | null } };
  number: { input: { firstPtsUs: number; axis: 'pts' | 'dts'; number: number }; output: number | null };
}
export type NativeAnalysisRequest = { [K in keyof NativeAnalysisCommands]: { id: number; type: K; input: NativeAnalysisCommands[K]['input'] } }[keyof NativeAnalysisCommands];
export type NativeAnalysisReply = { id: number; ok: true; data: NativeAnalysisCommands[keyof NativeAnalysisCommands]['output'] } | { id: number; ok: false; error: string };
