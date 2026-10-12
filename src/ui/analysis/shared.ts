export type AnalysisAction = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
export const MIN_ANALYSIS_SPAN_US = 10_000;
/** One session-time viewport for overview and deep bitstream diagrams. */
export interface AnalysisViewport {
  axis(): import('../../analysis/types.ts').AnalysisAxis;
  range(): { start: number; end: number };
  domain(): { start: number; end: number };
  containerColumn(): { timeUs: number; widthUs: number };
  set(start: number | null, end?: number): void;
}

/** View-only shared inspection; exact AU identity wins over timestamp proximity. */
export interface ChartHover {
  timeUs: number;
  /** Continuous pointer position on the selected session time axis; frame identity remains snapped. */
  cursorTimeUs?: number;
  slot?: import('../../model.ts').Slot;
  au?: number;
  sourceVersion?: string;
  /** DTS cannot be used as PTS without an indexed frame mapping. */
  unmapped?: boolean;
}
