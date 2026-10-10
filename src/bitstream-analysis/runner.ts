import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
  BUDGET,
  validateResult,
  validateTarget,
  validateRange,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisBlock,
  AnalysisRangeTarget,
} from "./contract.ts";
import { inspectPacketPicture } from "../packet-picture.ts";
import { openAnalysisInput } from "./input.ts";
import type { AnalysisReader } from "./input.ts";
import { AnalysisFailure, coreFailure } from "./failure.ts";
export async function analyzePicture(
  reader: AnalysisReader,
  target: AnalysisTarget,
  core: any,
  buildId: string,
  signal: AbortSignal,
  options: {
    input?: Awaited<ReturnType<typeof openAnalysisInput>>;
    sequential?: boolean;
    endSourcePtsUs?: number;
    onResult?: (result: AnalysisResult) => Promise<void>;
  } = {},
): Promise<AnalysisResult> {
  validateTarget(target);
  if (core._vpa_abi() !== 1) throw new Error("Analysis ABI mismatch");
  const started = performance.now(),
    input = options.input ?? (await openAnalysisInput(reader, signal));
  let opened = false;
  try {
    const plan = await input.plan(target);
    if (options.sequential) plan.start = 0;
    const description = input.configurations[plan.target.configuration];
    let pointer = core._malloc(description.length);
    if (!pointer)
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis heap budget exceeded",
      );
    try {
      core.HEAPU8.set(description, pointer);
      const ret = core._vpa_open(
        { h264: 1, hevc: 2, vvc: 3 }[input.codec],
        pointer,
        description.length,
      );
      if (ret < 0) throw coreFailure(ret, "Analysis open failed");
      opened = true;
    } finally {
      core._free(pointer);
    }
    const desired = new Set(
      input.packets
        .filter((p) =>
          options.endSourcePtsUs === undefined
            ? p.au === plan.target.au
            : p.pts >= target.sourcePtsUs && p.pts < options.endSourcePtsUs,
        )
        .map((p) => p.au),
    );
    if (!desired.size || desired.size > 32)
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis range result count budget exceeded",
      );
    if (
      [...desired].some(
        (au) => input.packets[au].configuration !== plan.target.configuration,
      )
    )
      throw new AnalysisFailure(
        "unsupported-picture-layout",
        "Analysis range crosses a configuration segment",
      );
    let count = 0,
      packetBytes = 0,
      drained = false;
    const take = (): AnalysisResult | null => {
      const au = core._vpa_ordinal(),
        n = core._vpa_count(),
        bytes = n * 12;
      if (
        !Number.isInteger(n) ||
        n < 0 ||
        n > BUDGET.blocks ||
        bytes > BUDGET.resultBytes ||
        n * 128 + 4096 > BUDGET.resultBytes
      )
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis output budget exceeded",
        );
      let result: AnalysisResult | null = null;
      if (desired.has(au)) {
        const selected = input.packets[au];
        const invalid = core._vpa_invalid() !== 0,
          depth = core._vpa_depth(),
          ptr = core._vpa_blocks(),
          width = core._vpa_width(),
          height = core._vpa_height();
        if (ptr < 0 || ptr + bytes > core.HEAPU8.length)
          throw new Error("Invalid analysis output pointer");
        const view = new DataView(core.HEAPU8.buffer, ptr, bytes),
          blocks: AnalysisBlock[] = [];
        let sum = 0,
          area = 0;
        if (!invalid)
          for (let i = 0; i < n; i++) {
            const at = i * 12,
              block = {
                x: view.getUint16(at, true),
                y: view.getUint16(at + 2, true),
                width: view.getUint16(at + 4, true),
                height: view.getUint16(at + 6, true),
                qp: depth === 8 ? view.getInt16(at + 8, true) : null,
                mode: ({ 1: "intra", 2: "inter", 3: "skip" } as const)[
                  view.getUint8(at + 10) as 1 | 2 | 3
                ],
              };
            blocks.push(block);
            sum += (block.qp ?? 0) * block.width * block.height;
            area += block.width * block.height;
          }
        result = {
          schema: 1,
          codec: input.codec,
          analyzerVersion: ANALYZER_VERSION,
          buildId,
          recipe: ANALYSIS_RECIPE,
          picture: input.picture(selected, target.sourceVersion),
          sourcePtsUs: core._vpa_pts(),
          width,
          height,
          confidence: invalid ? "partial" : "exact",
          reasons: invalid ? ["invalid-field-depth-or-decoder-output"] : [],
          reasonCodes: invalid
            ? ["incomplete-reference-state"]
            : depth !== 8
              ? ["unsupported-qp-depth"]
              : [],
          capabilities: {
            blocks: invalid ? "unsupported" : "ready",
            qp: invalid || depth !== 8 ? "unsupported" : "ready",
            modes: invalid ? "unsupported" : "ready",
            motion: "unsupported",
          },
          qp: {
            component: "luma",
            bitDepth: depth,
            weighting: "pixel-area",
            mean: area && depth === 8 ? sum / area : null,
          },
          blocks,
          metrics: {
            startAu: plan.start,
            packets: count,
            bytesRead: input.bytesRead,
            elapsedMs: performance.now() - started,
            recordBytes: core._vpa_record_bytes(),
            heapBytes: core.HEAPU8.length,
          },
        };
        if (result.sourcePtsUs !== selected.pts)
          throw new Error("Analyzer output timestamp mismatch");
        try {
          validateResult(result);
        } catch (error) {
          if (
            !(error instanceof AnalysisFailure) ||
            error.code !== "unsupported-picture-layout"
          )
            throw error;
          result = {
            ...result,
            confidence: "partial",
            reasons: [error instanceof Error ? error.message : String(error)],
            reasonCodes: ["unsupported-picture-layout"],
            blocks: [],
            capabilities: {
              blocks: "unsupported",
              qp: "unsupported",
              modes: "unsupported",
              motion: "unsupported",
            },
          };
        }
      }
      if (core._vpa_take(BUDGET.resultBytes) < 0)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis take budget exceeded",
        );
      return result;
    };
    for (let cursor = plan.start; ; ) {
      signal.throwIfAborted();
      const ret = core._vpa_step();
      if (ret === 1) {
        const result = take();
        if (result) {
          await options.onResult?.(result);
          desired.delete(result.picture.au);
          if (!desired.size) return result;
        }
        continue;
      }
      if (ret !== 0 && ret !== 2)
        throw coreFailure(ret, "Analysis decoder failed");
      if (ret === 2)
        throw new AnalysisFailure(
          "incomplete-reference-state",
          "Target picture was not output",
        );
      if (count >= BUDGET.packets || packetBytes >= BUDGET.inputBytes)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis preroll budget exceeded",
        );
      const packet = input.packets[cursor];
      if (!packet || packet.configuration !== plan.target.configuration) {
        if (drained)
          throw new AnalysisFailure(
            "incomplete-reference-state",
            "Incomplete analysis output",
          );
        const ret = core._vpa_drain();
        if (ret < 0) throw coreFailure(ret, "Analysis drain failed");
        drained = true;
        continue;
      }
      if (
        packet.size > BUDGET.packetBytes ||
        packetBytes + packet.size > BUDGET.inputBytes
      )
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis input budget exceeded",
        );
      const bytes = await input.read(packet.offset, packet.size),
        evidence = inspectPacketPicture(input.codec, description, bytes);
      if (!evidence.singlePicture)
        throw new AnalysisFailure(
          "unsupported-picture-layout",
          `Unsupported picture layout: ${evidence.reason}`,
        );
      pointer = core._malloc(bytes.length);
      if (!pointer)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis heap budget exceeded",
        );
      try {
        core.HEAPU8.set(bytes, pointer);
        const ret = core._vpa_feed(
          pointer,
          bytes.length,
          packet.pts,
          packet.dts,
          packet.au,
        );
        if (ret === 2) continue;
        if (ret < 0) throw coreFailure(ret, "Analysis packet failed");
      } finally {
        core._free(pointer);
      }
      count++;
      packetBytes += packet.size;
      cursor++;
      // Cooperative cancel/checkpoint outside synchronous WASM; hard cancellation
      // terminates the isolated worker. No producer advances while take is pending.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    if (opened) core._vpa_close();
    input.close();
  }
}

/** One bounded decoder session publishes picture chunks incrementally. The
 * consumer callback is awaited before production advances (backpressure). */
export async function analyzeRange(
  reader: AnalysisReader,
  target: AnalysisRangeTarget,
  core: any,
  buildId: string,
  signal: AbortSignal,
  onResult: (result: AnalysisResult) => Promise<void>,
) {
  validateRange(target);
  // Reuse this independent metadata plan across all picture chunks; the
  // decoder session owns its reader and closes it on success or failure.
  const input = await openAnalysisInput(reader, signal);
  let first: number;
  try {
    const matches = input.packets
      .filter(
        (p) =>
          p.pts >= target.firstPtsUs + target.startUs &&
          p.pts < target.firstPtsUs + target.endUs,
      )
      .sort((a, b) => a.pts - b.pts);
    if (
      !matches.length ||
      matches.length > 32 ||
      new Set(matches.map((p) => p.pts)).size !== matches.length
    )
      throw new AnalysisFailure(
        matches.length > 32 ? "resource-limit" : "ambiguous-picture-identity",
        "Missing, ambiguous or oversized analysis range",
      );
    first = matches[0].pts;
  } catch (error) {
    input.close();
    throw error;
  }
  return analyzePicture(
    reader,
    {
      sourceVersion: target.sourceVersion,
      sourcePtsUs: first,
      normalizedMediaUs: first - target.firstPtsUs,
    },
    core,
    buildId,
    signal,
    { input, endSourcePtsUs: target.firstPtsUs + target.endUs, onResult },
  );
}
