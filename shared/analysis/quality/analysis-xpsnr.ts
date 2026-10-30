import { validateSourcePlanePair } from "./psnr.ts";
import type { PsnrFrame, PsnrRoi } from "./psnr.ts";
import { packAnalysisPixels } from "./analysis-core.ts";
import type { QualityCore } from "./analysis-core.ts";

export type XpsnrCore = Pick<QualityCore, "HEAPU8" | "_malloc" | "_free"> & {
  _vpa_xpsnr_abi(): number;
  _vpa_xpsnr_open(
    width: number,
    height: number,
    depth: number,
    rateNum: number,
    rateDen: number,
    frames: number,
  ): number;
  _vpa_xpsnr_feed(
    reference: number,
    distorted: number,
    bytes: number,
    index: number,
  ): number;
  _vpa_xpsnr_score(plane: number): number;
  _vpa_xpsnr_pool(plane: number): number;
  _vpa_xpsnr_flush(): number;
  _vpa_xpsnr_close(): number;
};
export function validateXpsnrCore(value: unknown): asserts value is XpsnrCore {
  const core = value as XpsnrCore;
  if (
    !core ||
    !["abi", "open", "feed", "score", "pool", "flush", "close"].every(
      (name) =>
        typeof (core as unknown as Record<string, unknown>)[
          `_vpa_xpsnr_${name}`
        ] === "function",
    ) ||
    core._vpa_xpsnr_abi() !== 1 ||
    !(core.HEAPU8 instanceof Uint8Array)
  )
    throw Error("Analysis core lacks pixel XPSNR ABI 1");
}
/** XPSNR owns exactly one clip history. Pixels are already matched by the host;
 * the kernel only receives ordered packed planes and an exact declared rate. */
export class AnalysisXpsnrScorer {
  private reference = 0;
  private distorted = 0;
  private bytes = 0;
  private geometry = "";
  private count = 0;
  private opened = false;
  private finished = false;
  private closed = false;
  private values: { index: number; planes: [number, number, number] }[] = [];
  private core: XpsnrCore;
  private options: {
    frames: number;
    rate: { numerator: number; denominator: number };
  };
  constructor(
    core: XpsnrCore,
    options: {
      frames: number;
      rate: { numerator: number; denominator: number };
    },
  ) {
    this.core = core;
    this.options = structuredClone(options);
    validateXpsnrCore(core);
    if (
      !Number.isSafeInteger(options.frames) ||
      options.frames < 1 ||
      options.frames > 1000000 ||
      !Object.values(options.rate).every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff,
      )
    )
      throw Error("Invalid XPSNR clip recipe");
  }
  private check(code: number) {
    if (code) throw Error(`Analysis XPSNR failed (${code})`);
  }
  private planes(read: (plane: number) => number): [number, number, number] {
    const values = [0, 1, 2].map(read);
    if (values.some((n) => !Number.isFinite(n) && n !== Infinity))
      throw Error("Invalid XPSNR score");
    return values as [number, number, number];
  }
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
      throw Error("XPSNR frame order changed");
    const pair = validateSourcePlanePair({
      domain: "source-yuv-code-values",
      reference,
      distorted,
      roi,
    });
    const depth = pair.a.layout.bitDepth,
      geometry = JSON.stringify([roi.width, roi.height, depth]);
    if (this.geometry && this.geometry !== geometry)
      throw Error("XPSNR geometry changed");
    try {
      if (!this.opened) {
        this.check(
          this.core._vpa_xpsnr_open(
            roi.width,
            roi.height,
            depth,
            this.options.rate.numerator,
            this.options.rate.denominator,
            this.options.frames,
          ),
        );
        this.opened = true;
        this.geometry = geometry;
        this.bytes = ((roi.width * roi.height * 3) / 2) * (depth === 8 ? 1 : 2);
        this.reference = this.core._malloc(this.bytes);
        this.distorted = this.core._malloc(this.bytes);
        if (!this.reference || !this.distorted)
          throw Error("XPSNR input allocation failed");
      }
      packAnalysisPixels(this.core, reference, roi, this.reference);
      packAnalysisPixels(this.core, distorted, roi, this.distorted);
      this.check(
        this.core._vpa_xpsnr_feed(
          this.reference,
          this.distorted,
          this.bytes,
          index,
        ),
      );
      this.values.push({
        index,
        planes: this.planes((plane) => this.core._vpa_xpsnr_score(plane)),
      });
      this.count++;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  finish() {
    if (this.closed || this.count !== this.options.frames)
      throw Error("Incomplete XPSNR clip");
    if (!this.finished) {
      this.check(this.core._vpa_xpsnr_flush());
      this.finished = true;
    }
    return {
      frames: this.values.map((v) => ({
        index: v.index,
        planes: [...v.planes] as [number, number, number],
      })),
      pooled: this.planes((plane) => this.core._vpa_xpsnr_pool(plane)),
    };
  }
  get heapBytes() {
    return this.core.HEAPU8.byteLength;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.opened) this.core._vpa_xpsnr_close();
    if (this.reference) this.core._free(this.reference);
    if (this.distorted) this.core._free(this.distorted);
    this.reference = this.distorted = 0;
    this.values = [];
  }
}
