import { readNalus, readContainerHeader } from "./diagrams.ts";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
  BUDGET,
  validateResult,
  validateTarget,
  validateRange,
  validateStream,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisBlock,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
} from "./contract.ts";
import { inspectPacketPicture } from "../packet-picture.ts";
import { openAnalysisInput } from "./input.ts";
import type { AnalysisReader } from "./input.ts";
import { AnalysisFailure, coreFailure } from "./failure.ts";
import { groupAnalysisGops, gopForAu } from './stream.ts';
import type { AnalysisIndexFrontier, StreamProgress } from './stream.ts';
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
    stream?: AnalysisStreamTarget;
    onProgress?: (progress: StreamProgress) => Promise<void>;
  } = {},
): Promise<AnalysisResult> {
  validateTarget(target);
  const started = performance.now(),
    input = options.input ?? (await openAnalysisInput(reader, signal, !!options.stream));
  let opened = false;
  try {
    if (core._vpa_abi() !== 1) throw new Error("Analysis ABI mismatch");
    const plan = await input.plan(target);
    if (options.sequential) plan.start = 0;
    let groups = options.stream ? groupAnalysisGops(input.packets.slice(0, input.sealedEnd)) : [];
    const extend = async (cursor: number) => {
      if (!input.ensure || cursor < input.sealedEnd) return;
      const previousEnd = input.sealedEnd;
      await input.ensure(cursor);
      groups.push(...groupAnalysisGops(input.packets.slice(previousEnd, input.sealedEnd)));
    };
    const seen = options.stream ? new Uint8Array(input.totalPackets) : undefined;
    if (options.stream && new Set(input.packets.map(p => p.pts)).size !== input.packets.length)
      throw new AnalysisFailure('ambiguous-picture-identity', 'Duplicate picture timestamps');
    let configuration = plan.target.configuration;
    let description = input.configurations[configuration];
    const containerHeaders = new Map<number, ReturnType<typeof readContainerHeader>>();
    let pointer = 0;
    const open = () => {
      if (!containerHeaders.has(configuration)) containerHeaders.set(configuration, readContainerHeader(input.codec, description));
      pointer = core._malloc(description.length);
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
    };
    open();
    const desired = new Set(
      input.packets
        .filter((p) =>
          options.endSourcePtsUs === undefined
            ? p.au === plan.target.au
            : p.pts >= target.sourcePtsUs && p.pts < options.endSourcePtsUs,
        )
        .map((p) => p.au),
    );
    if (!options.stream && (!desired.size || desired.size > 32))
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis range result count budget exceeded",
      );
    if (
      !options.stream && [...desired].some(
        (au) => input.packets[au].configuration !== plan.target.configuration,
      )
    )
      throw new AnalysisFailure(
        "unsupported-picture-layout",
        "Analysis range crosses a configuration segment",
      );
    let count = 0,
      packetBytes = 0,
      drained = false,
      sinceOutputPackets = 0,
      sinceOutputBytes = 0,
      outputPictures = 0;
    const nalus = new Map<number, import("./diagrams.ts").NaluRecord[]>();
    let last: AnalysisResult | undefined;
    const progress = async (complete = false) => {
      if (!options.stream) return;
      await options.onProgress?.({ pictures: outputPictures, totalPictures: input.totalPackets, indexComplete: input.indexComplete, waitingForIndex: false,
        checkedUs: complete ? Math.max(options.stream.durationUs, input.sourceEndUs - options.stream.firstPtsUs) : Math.min(options.stream.durationUs - 1, Math.floor(options.stream.durationUs * outputPictures / input.totalPackets)),
        totalUs: complete ? Math.max(options.stream.durationUs, input.sourceEndUs - options.stream.firstPtsUs) : options.stream.durationUs, gopStartAu: last?.gop?.startAu });
    };
    await progress();
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
      if (options.stream || desired.has(au)) {
        if (!Number.isSafeInteger(au) || au < 0 || au >= input.packets.length || seen?.[au])
          throw new Error('Invalid or duplicate analyzer AU');
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
          nalus: nalus.get(au),
          containerHeader: containerHeaders.get(selected.configuration),
          ...(core._vpa_reference_abi?.() === 1 ? { references: (() => {
            const count = core._vpa_ref_count(), ptr = core._vpa_refs();
            if (!Number.isInteger(count) || count < 0 || count > 64 || ptr < 0 || ptr + count * 8 > core.HEAPU8.length) throw new Error('Invalid reference output');
            const invalidRefs = core._vpa_refs_invalid() || invalid;
            const view = new DataView(core.HEAPU8.buffer, ptr, count * 8);
            return { kind: 'active-lists' as const, state: invalidRefs ? 'unsupported' as const : 'ready' as const,
              poc: core._vpa_poc(), frameType: (['B', 'P', 'I'] as const)[core._vpa_picture_type()],
              edges: invalidRefs ? [] : Array.from({ length: count }, (_, i) => ({ au: view.getUint32(i * 8, true), list: view.getUint32(i * 8 + 4, true) as 0 | 1 })) };
          })() } : {}),
          ...(options.stream ? { gop: { ...gopForAu(groups, au) } } : {}),
          codec: input.codec,
          analyzerVersion: ANALYZER_VERSION,
          buildId,
          recipe: ANALYSIS_RECIPE,
          picture: input.picture(selected, target.sourceVersion),
          sourcePtsUs: core._vpa_pts(),
          sourceDtsUs: selected.dts,
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
        nalus.delete(au);
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
          if (seen) seen[result.picture.au] = 1;
          outputPictures++;
          last = result;
          await options.onResult?.(result);
          signal.throwIfAborted();
          await progress();
          if (!options.stream) {
            desired.delete(result.picture.au);
            if (!desired.size) return result;
          }
        }
        sinceOutputPackets = 0; sinceOutputBytes = 0;
        continue;
      }
      if (ret !== 0 && ret !== 2)
        throw coreFailure(ret, "Analysis decoder failed");
      if (ret === 2) {
        if (options.stream && drained && cursor < input.packets.length && input.packets[cursor].configuration !== configuration) {
          // Reopen only for an actual configuration change, never at a result/GOP boundary.
          const packet = input.packets[cursor];
          const bytes = await input.read(packet.offset, packet.size);
          const nextDescription = input.configurations[packet.configuration];
          if (!inspectPacketPicture(input.codec, nextDescription, bytes).closedRandomAccess)
            throw new AnalysisFailure('no-safe-anchor-within-budget', 'Configuration change has no closed anchor');
          core._vpa_close(); opened = false;
          configuration = packet.configuration; description = nextDescription;
          open(); drained = false; sinceOutputPackets = 0; sinceOutputBytes = 0;
          continue;
        }
        if (options.stream && last && input.indexComplete && outputPictures === input.totalPackets) {
          await progress(true); return last;
        }
        throw new AnalysisFailure(
          "incomplete-reference-state",
          "Target picture was not output",
        );
      }
      if ((options.stream ? sinceOutputPackets : count) >= BUDGET.packets ||
          (options.stream ? sinceOutputBytes : packetBytes) >= BUDGET.inputBytes)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis preroll budget exceeded",
        );
      if (options.stream) await extend(cursor);
      const packet = input.packets[cursor];
      if (!packet || packet.configuration !== configuration) {
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
        (options.stream ? sinceOutputBytes : packetBytes) + packet.size > BUDGET.inputBytes
      )
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis input budget exceeded",
        );
      const bytes = await input.read(packet.offset, packet.size),
        evidence = inspectPacketPicture(input.codec, description, bytes);
      if (options.stream || desired.has(packet.au)) nalus.set(packet.au, readNalus(input.codec, description, bytes));
      if (!evidence.singlePicture)
        throw new AnalysisFailure(
          "unsupported-picture-layout",
          `Unsupported picture layout: ${evidence.reason}`,
        );
      if (options.stream) {
        const group = gopForAu(groups, packet.au);
        if (packet.au === group.startAu) group.anchor = evidence.closedRandomAccess ? 'closed' : 'dependent';
      }
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
      count++; sinceOutputPackets++;
      packetBytes += packet.size; sinceOutputBytes += packet.size;
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

/** From-head continuous execution. Picture chunks are published immediately,
 * grouped by stable AU/GOP metadata; no decoder reset at storage boundaries. */
export async function analyzeStream(
  reader: AnalysisReader, target: AnalysisStreamTarget, core: any, buildId: string,
  signal: AbortSignal, onResult: (result: AnalysisResult) => Promise<void>,
  onProgress: (progress: StreamProgress) => Promise<void>,
  frontier?: () => Promise<AnalysisIndexFrontier>,
) {
  validateStream(target);
  let latest: StreamProgress = { pictures: 0, totalPictures: 0, checkedUs: 0, totalUs: target.durationUs, indexComplete: false };
  const report = async (progress: StreamProgress) => { latest = progress; await onProgress(progress); };
  const input = await openAnalysisInput(reader, signal, true, { frontier,
    waiting: async waitingForIndex => { await report({ ...latest, waitingForIndex }); } });
  const first = input.packets[0];
  return analyzePicture(reader, { sourceVersion: target.sourceVersion,
    sourcePtsUs: first.pts, normalizedMediaUs: Math.max(0, first.pts - target.firstPtsUs) },
    core, buildId, signal, { input, sequential: true, stream: target, onResult, onProgress: report });
}
