import type { PsnrFrame, PsnrRoi } from "./psnr.ts";
import { validateSourcePlanePair } from "./psnr.ts";

/** Pixel-only exports on the existing analysis artifact. No clocks or decoder. */
export type QualityCore = {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _vpa_quality_abi(): number;
  _vpa_quality_error(): number;
  _vpa_quality_open(
    metrics: number,
    model: number,
    width: number,
    height: number,
    depth: number,
    frames: number,
  ): number;
  _vpa_quality_feed(
    reference: number,
    distorted: number,
    bytes: number,
    index: number,
  ): number;
  _vpa_quality_flush(): number;
  _vpa_quality_score(metric: number, index: number): number;
  _vpa_quality_pool(
    metric: number,
    pool: number,
    start: number,
    end: number,
  ): number;
  _vpa_quality_heat_frame(): number;
  _vpa_quality_heat_data(scale: number): number;
  _vpa_quality_heat_width(scale: number): number;
  _vpa_quality_heat_height(scale: number): number;
  _vpa_quality_close(): number;
};
export type QualityMetric = "vmaf" | "cambi";
const metricId = { vmaf: 1, cambi: 2 } as const;
const exports = [
  "abi",
  "error",
  "open",
  "feed",
  "flush",
  "score",
  "pool",
  "heat_frame",
  "heat_data",
  "heat_width",
  "heat_height",
  "close",
];
export function validateQualityCore(
  value: unknown,
): asserts value is QualityCore {
  const core = value as QualityCore;
  if (
    !core ||
    exports.some(
      (name) =>
        typeof (core as unknown as Record<string, unknown>)[
          `_vpa_quality_${name}`
        ] !== "function",
    ) ||
    core._vpa_quality_abi() !== 1 ||
    !(core.HEAPU8 instanceof Uint8Array)
  ) {
    throw new Error("Analysis core lacks the pixel scoring ABI 1");
  }
}

/** Owns one clip context. Only two packed input buffers and the current heatmap
 * are retained here. libvmaf retains temporal state and bounded per-frame scalar
 * features until final flush; callers must declare the complete frame budget. */
export class AnalysisScorer {
  private reference = 0;
  private distorted = 0;
  private bytes = 0;
  private geometry?: { width: number; height: number; depth: number };
  private count = 0;
  private finished = false;
  private closed = false;
  private opened = false;
  readonly metrics: readonly QualityMetric[];
  private core: QualityCore;
  private options: {
    metrics: readonly QualityMetric[];
    model?: "vmaf_v0_6_1" | "vmaf_v0_6_1neg";
    frames: number;
  };
  constructor(core: QualityCore, options: AnalysisScorer["options"]) {
    this.core = core;
    this.options = { ...options };
    validateQualityCore(core);
    if (
      !Number.isSafeInteger(options.frames) ||
      options.frames < 1 ||
      options.frames > 1_000_000 ||
      !options.metrics.length ||
      options.metrics.some((m) => !Object.hasOwn(metricId, m)) ||
      new Set(options.metrics).size !== options.metrics.length
    )
      throw new Error("Invalid scoring recipe");
    this.metrics = [...options.metrics];
  }
  private check(code: number) {
    if (code) throw new Error(`Analysis scoring failed (${code})`);
  }
  /** Frames must already be paired by verified AU identity. ROI is in visible
   * source pixels; this copies the exact same crop on both inputs, with no scale
   * or color conversion. A crop is a separate VMAF evaluation, never a heatmap. */
  feed(
    reference: PsnrFrame,
    distorted: PsnrFrame,
    roi: PsnrRoi,
    index: number,
  ) {
    if (
      this.closed ||
      this.finished ||
      index !== this.count ||
      index >= this.options.frames
    )
      throw new Error("Scoring frame order changed");
    const pair = validateSourcePlanePair({
      domain: "source-yuv-code-values",
      reference,
      distorted,
      roi,
    });
    const depth = pair.a.layout.bitDepth;
    const geometry = { width: roi.width, height: roi.height, depth };
    if (
      this.geometry &&
      JSON.stringify(this.geometry) !== JSON.stringify(geometry)
    )
      throw new Error("Scoring geometry changed");
    try {
      if (!this.opened) {
        const flags = this.metrics.reduce((n, m) => n | metricId[m], 0);
        this.check(
          this.core._vpa_quality_open(
            flags,
            this.options.model === "vmaf_v0_6_1neg" ? 1 : 0,
            roi.width,
            roi.height,
            depth,
            this.options.frames,
          ),
        );
        this.opened = true;
        this.geometry = geometry;
        this.bytes = ((roi.width * roi.height * 3) / 2) * (depth === 8 ? 1 : 2);
        this.reference = this.core._malloc(this.bytes);
        this.distorted = this.core._malloc(this.bytes);
        if (!this.reference || !this.distorted)
          throw new Error("Scoring input allocation failed");
      }
      this.pack(reference, roi, this.reference);
      this.pack(distorted, roi, this.distorted);
      this.check(
        this.core._vpa_quality_feed(
          this.reference,
          this.distorted,
          this.bytes,
          index,
        ),
      );
      this.count++;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private pack(frame: PsnrFrame, roi: PsnrRoi, pointer: number) {
    const { description: d, pixels } = frame,
      layout = d.yuv!;
    const bytes = layout.bitDepth === 8 ? 1 : 2;
    for (let plane = 0; plane < 3; plane++) {
      const divisor = plane ? 2 : 1,
        width = (roi.width / divisor) * bytes;
      const x = ((d.visibleRect.x + roi.x) / divisor) * bytes,
        top = (d.visibleRect.y + roi.y) / divisor;
      const p = layout.planes[plane];
      for (let y = 0; y < roi.height / divisor; y++) {
        const offset = p.offset + (top + y) * p.stride + x;
        this.core.HEAPU8.set(pixels.subarray(offset, offset + width), pointer);
        pointer += width;
      }
    }
  }
  heatmaps(index: number) {
    if (
      this.closed ||
      !this.metrics.includes("cambi") ||
      index !== this.count - 1 ||
      this.core._vpa_quality_heat_frame() !== index
    )
      throw new Error("Heatmap frame is unavailable");
    return Array.from({ length: 5 }, (_, scale) => {
      const pointer = this.core._vpa_quality_heat_data(scale),
        width = this.core._vpa_quality_heat_width(scale),
        height = this.core._vpa_quality_heat_height(scale);
      if (
        !pointer ||
        !width ||
        !height ||
        pointer + width * height * 2 > this.core.HEAPU8.byteLength
      )
        throw new Error("Invalid heatmap memory");
      // Copy before the next feed overwrites the map or memory grows.
      return {
        scale,
        width,
        height,
        bytes: this.core.HEAPU8.slice(pointer, pointer + width * height * 2),
      };
    });
  }
  score(metric: QualityMetric, index: number) {
    if (
      this.closed ||
      !this.metrics.includes(metric) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count
    )
      throw new Error("Score is unavailable");
    const score = this.core._vpa_quality_score(metricId[metric], index);
    this.check(this.core._vpa_quality_error());
    if (!Number.isFinite(score)) throw new Error("Non-finite score");
    return score;
  }
  finish() {
    if (this.closed || this.count !== this.options.frames)
      throw new Error("Incomplete scoring sequence");
    if (!this.finished) {
      this.check(this.core._vpa_quality_flush());
      this.finished = true;
    }
    return Object.fromEntries(
      this.metrics.map((metric) => {
        const pooled = Object.fromEntries(
          ["min", "max", "mean", "harmonic_mean"].map((name, i) => {
            const score = this.core._vpa_quality_pool(
              metricId[metric],
              i + 1,
              0,
              this.count - 1,
            );
            this.check(this.core._vpa_quality_error());
            if (!Number.isFinite(score))
              throw new Error("Non-finite pooled score");
            return [name, score];
          }),
        );
        return [
          metric,
          {
            frames: Array.from({ length: this.count }, (_, index) => ({
              index,
              score: this.score(metric, index),
            })),
            pooled,
          },
        ];
      }),
    ) as Partial<
      Record<
        QualityMetric,
        {
          frames: { index: number; score: number }[];
          pooled: {
            min: number;
            max: number;
            mean: number;
            harmonic_mean: number;
          };
        }
      >
    >;
  }
  get heapBytes() {
    return this.core.HEAPU8.byteLength;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reference) this.core._free(this.reference);
    if (this.distorted) this.core._free(this.distorted);
    if (this.opened) this.core._vpa_quality_close();
  }
}
