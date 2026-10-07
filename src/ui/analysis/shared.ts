export type AnalysisAction = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
export const MIN_ANALYSIS_SPAN_US = 10_000;
