import {isAnnexB} from '../nal-framing.ts';
import { validateAnalysisCore } from './core-abi.ts';
import { readNalus, readContainerHeader } from "./diagrams.ts";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
  BUDGET,
  validateResult,
  validateTarget,
  validateRange,
  validateStream,
  pictureId,
} from "./contract.ts";
import type {
  AnalysisResult,
  AnalysisTarget,
  AnalysisBlock,
  AnalysisRangeTarget,
  AnalysisStreamTarget,
  SourcePictureKey,
} from "./contract.ts";
import { inspectPacketPicture } from "../packet-picture.ts";
import { openAnalysisInput } from "./input.ts";
import type { AnalysisReader } from "./input.ts";
import { AnalysisFailure, coreFailure } from "./failure.ts";
import { groupAnalysisGops, gopForAu, viewportAnalysisGops } from './stream.ts';
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
    keepInput?: boolean;
    desiredAus?: ReadonlySet<number>;
    viewport?: boolean;
    endSourcePtsUs?: number;
    onResult?: (result: AnalysisResult) => Promise<void>;
    stream?: AnalysisStreamTarget;
    onProgress?: (progress: StreamProgress) => Promise<void>;
    cached?: (picture: SourcePictureKey) => Promise<AnalysisResult | null>;
  } = {},
): Promise<AnalysisResult> {
  validateTarget(target);
  const started = performance.now(),
    input = options.input ?? (await openAnalysisInput(reader, signal, !!options.stream, {sourceVersion:target.sourceVersion,indexIdentity:target.indexIdentity}));
  let opened = false;
  try {
    const firstPacket=input.packets[0];
    const cachedAnchor=(hit: AnalysisResult | null | undefined, packet: typeof firstPacket) =>
      !!hit && input.codec==='h264' && isAnnexB(input.configurations[packet.configuration]) &&
      reusableResult(hit,input.codec,buildId,input.picture(packet,target.sourceVersion),packet.pts) &&
      hit.gop?.anchor==='closed' && hit.gop.startAu===packet.au && hit.gop.configuration===packet.configuration &&
      !!hit.containerHeader && !!hit.references && hit.nalus?.filter(n=>n.type===1 || n.type===5).length===1 && hit.nalus.some(n=>n.type===5);
    const firstHit=options.stream && options.cached ? await options.cached(input.picture(firstPacket,target.sourceVersion)) : null;
    signal.throwIfAborted();
    // A matching exact cached IDR already carries source-bound syntax proof.
    // It may seed a cache-only TS stream without instantiating demux/decoder.
    const plan = cachedAnchor(firstHit,firstPacket)
      ? {start:0,target:firstPacket,identity:input.picture(firstPacket,target.sourceVersion)}
      : await input.plan(target);
    if (options.sequential) plan.start = 0;
    let groups = options.stream ? groupAnalysisGops(input.packets.slice(0, input.sealedEnd)) : [];
    const extend = async (cursor: number) => {
      if (!input.ensure || cursor < input.sealedEnd) return;
      const previousEnd = input.sealedEnd;
      await input.ensure(cursor);
      groups.push(...groupAnalysisGops(input.packets.slice(previousEnd, input.sealedEnd)));
    };
    const timestampCounts = new Map<number, number>();
    let identityCounted = 0;
    const refreshIdentities = () => {
      for (; identityCounted < Math.min(input.sealedEnd, input.packets.length); identityCounted++) {
        const pts = input.packets[identityCounted].pts;
        timestampCounts.set(pts, (timestampCounts.get(pts) ?? 0) + 1);
      }
    };
    refreshIdentities();
    const seen = options.stream ? new Set<number>() : undefined;
    const decoded = options.stream ? new Set<number>() : undefined;
    if (options.stream && new Set(input.packets.map(p => p.pts)).size !== input.packets.length)
      throw new AnalysisFailure('ambiguous-picture-identity', 'Duplicate picture timestamps');
    let configuration = plan.target.configuration;
    let description = input.configurations[configuration];
    const containerHeaders = new Map<number, ReturnType<typeof readContainerHeader>>();
    let pointer = 0;
    const open = async () => {
      if (typeof core === 'function') core = await core();
      signal.throwIfAborted();
      validateAnalysisCore(core);
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
    if (!options.stream) await open();
    const desired = new Set(options.desiredAus ??
      input.packets
        .filter((p) =>
          options.endSourcePtsUs === undefined
            ? p.au === plan.target.au
            : p.pts >= target.sourcePtsUs && p.pts < options.endSourcePtsUs,
        )
        .map((p) => p.au),
    );
    if (!options.stream && (!desired.size || desired.size > (options.viewport ? 250000 : 32)))
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
        checkedUs: complete ? Math.max(options.stream.durationUs, input.sourceEndUs - options.stream.firstPtsUs) : Math.min(options.stream.durationUs - 1, (input.totalPackets ? Math.floor(options.stream.durationUs * outputPictures / input.totalPackets) : 0)),
        totalUs: complete ? Math.max(options.stream.durationUs, input.sourceEndUs - options.stream.firstPtsUs) : options.stream.durationUs, gopStartAu: last?.gop?.startAu });
    };
    const publish = async (result: AnalysisResult) => {
      if (seen) seen.add(result.picture.au);
      outputPictures++;
      last = result;
      await options.onResult?.(result);
      signal.throwIfAborted();
      input.acknowledge?.();
      await progress();
    };
    const prepared = new Set<number>();
    let streamAnchor = plan.start;
    // Cache records are fetched/published one at a time, never a GOP-sized
    // array of blocks. Published hits remain coverage even if LRU evicts them.
    const cachedGroup = async (cursor: number): Promise<number | null> => {
      if (!options.stream || !options.cached) return null;
      await extend(cursor);
      if (cursor >= input.sealedEnd) return null;
      const group = gopForAu(groups, cursor);
      if (cursor !== group.startAu || prepared.has(cursor)) return null;
      prepared.add(cursor);
      const first = input.packets[cursor];
      if (first.size > BUDGET.packetBytes) throw new AnalysisFailure('resource-limit', 'Analysis packet budget exceeded');
      const anchorHit=await options.cached(input.picture(first,target.sourceVersion));
      const evidence = cachedAnchor(anchorHit,first) ? {singlePicture:true,closedRandomAccess:true}
        : inspectPacketPicture(input.codec, input.configurations[first.configuration], await input.readUnit(first));
      if (!evidence.singlePicture) throw new AnalysisFailure('unsupported-picture-layout', `Unsupported picture layout: ${evidence.reason}`);
      group.anchor = evidence.closedRandomAccess ? 'closed' : 'dependent';
      if (evidence.closedRandomAccess) streamAnchor = cursor;
      let complete = true;
      for (let au = group.startAu; au < group.endAu; au++) {
        signal.throwIfAborted();
        const packet = input.packets[au], picture = input.picture(packet, target.sourceVersion);
        const hit = await options.cached(picture);
        signal.throwIfAborted();
        if (hit && reusableResult(hit, input.codec, buildId, picture, packet.pts) && hit.nalus && hit.containerHeader && hit.references) {
          if (!seen!.has(au)) await publish({ ...hit, gop: { ...group } });
        } else complete = false;
      }
      if (!complete) return null;
      // Dropping decoder state is safe only when the next uncached work can
      // begin at a syntax-proven closed anchor. Container key flags are not proof.
      const next = input.packets[group.endAu];
      if (next && opened) {
        if (next.size > BUDGET.packetBytes) throw new AnalysisFailure('resource-limit', 'Analysis packet budget exceeded');
        const boundary = inspectPacketPicture(input.codec, input.configurations[next.configuration], await input.readUnit(next));
        if (!boundary.singlePicture || !boundary.closedRandomAccess) return null;
      } else if (!next && !input.indexComplete) return null;
      return group.endAu;
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
        if (!Number.isSafeInteger(au) || au < 0 || au >= input.packets.length || decoded?.has(au))
          throw new Error('Invalid or duplicate analyzer AU');
        if (decoded) decoded.add(au);
      }
      if ((options.stream && !seen!.has(au)) || (!options.stream && desired.has(au))) {
        const selected = input.packets[au];
        refreshIdentities();
        if (timestampCounts.get(selected.pts) !== 1)
          throw new AnalysisFailure('ambiguous-picture-identity', 'Duplicate source picture timestamps');
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
          references: (() => {
            const count = core._vpa_ref_count(), ptr = core._vpa_refs();
            if (!Number.isInteger(count) || count < 0 || count > 64 || ptr < 0 || ptr + count * 8 > core.HEAPU8.length) throw new Error('Invalid reference output');
            const invalidRefs = core._vpa_refs_invalid() || invalid;
            const view = new DataView(core.HEAPU8.buffer, ptr, count * 8);
            return { kind: 'active-lists' as const, state: invalidRefs ? 'unsupported' as const : 'ready' as const,
              poc: core._vpa_poc(), frameType: (['B', 'P', 'I'] as const)[core._vpa_picture_type()],
              edges: invalidRefs ? [] : Array.from({ length: count }, (_, i) => ({ au: view.getUint32(i * 8, true), list: view.getUint32(i * 8 + 4, true) as 0 | 1 })) };
          })(),
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
      nalus.delete(au);
      if (core._vpa_take(BUDGET.resultBytes) < 0)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis take budget exceeded",
        );
      return result;
    };
    let skipAfterDrain: number | null = null;
    for (let cursor = plan.start; ; ) {
      signal.throwIfAborted();
      if (!opened) {
        if (options.stream) await extend(cursor);
        if (input.indexComplete && cursor >= input.totalPackets! && outputPictures === input.totalPackets && last) {
          await progress(true);
          return last;
        }
        const skip = await cachedGroup(cursor);
        if (skip !== null) { cursor = skip; continue; }
        if (!input.packets[cursor]) throw new AnalysisFailure('incomplete-reference-state', 'Missing stream restart packet');
        // Every skipped group was inspected in source order. Retain its last
        // proven closed anchor, including across long dependent GOP chains.
        // Reconstruct references continuously under the usual per-output budget;
        // a cached prefix must not turn a valid stream into a random-seek failure.
        if (options.stream) cursor = streamAnchor;
        plan.start = cursor;
        decoded?.clear();
        configuration = input.packets[cursor].configuration;
        description = input.configurations[configuration];
        await open();
        drained = false;
      }
      const ret = core._vpa_step();
      if (ret === 1) {
        const result = take();
        if (result) {
          await publish(result);
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
        if (skipAfterDrain !== null) {
          core._vpa_close(); opened = false;
          cursor = skipAfterDrain; skipAfterDrain = null;
          sinceOutputPackets = 0; sinceOutputBytes = 0;
          continue;
        }
        if (options.stream && drained && cursor < input.packets.length && (input.packets[cursor].configuration !== configuration || input.packets[cursor].discontinuity)) {
          // An uncached configuration boundary still requires a closed anchor.
          const packet = input.packets[cursor];
          const bytes = await input.readUnit(packet);
          const nextDescription = input.configurations[packet.configuration];
          if (!inspectPacketPicture(input.codec, nextDescription, bytes).closedRandomAccess)
            throw new AnalysisFailure('no-safe-anchor-within-budget', 'Configuration change has no closed anchor');
          core._vpa_close(); opened = false;
          configuration = packet.configuration; description = nextDescription; plan.start = cursor;
          await open(); drained = false; sinceOutputPackets = 0; sinceOutputBytes = 0;
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
      if ((options.stream || options.viewport ? sinceOutputPackets : count) >= BUDGET.packets ||
          (options.stream || options.viewport ? sinceOutputBytes : packetBytes) >= BUDGET.inputBytes)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis preroll budget exceeded",
        );
      if (options.stream) await extend(cursor);
      const skip = await cachedGroup(cursor);
      if (skip !== null) {
        const ret = core._vpa_drain();
        if (ret < 0) throw coreFailure(ret, 'Analysis cache-boundary drain failed');
        drained = true; skipAfterDrain = skip;
        continue;
      }
      const packet = input.packets[cursor];
      if (!packet || packet.configuration !== configuration || (packet.discontinuity && cursor !== plan.start)) {
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
        (options.stream || options.viewport ? sinceOutputBytes : packetBytes) + packet.size > BUDGET.inputBytes
      )
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis input budget exceeded",
        );
      const bytes = await input.readUnit(packet),
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
        if (input.rawTiming && packet.timing?.pts == null)
          throw new AnalysisFailure('ambiguous-picture-identity', 'Derived packet time cannot stand in for original container PTS');
        if (packet.dts === null && !input.rawTiming)
          throw new AnalysisFailure('internal-error', 'Unknown packet clocks require the explicit feed-known contract');
        const ret = input.rawTiming
          ? core._vpa_feed_known(pointer, bytes.length, packet.pts, packet.dts ?? 0,
              (packet.timing?.pts != null ? 1 : 0) | (packet.timing?.dts != null ? 2 : 0), packet.au)
          : core._vpa_feed(pointer, bytes.length, packet.pts, packet.dts ?? 0, packet.au);
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
    if (!options.keepInput) input.close();
  }
}

function reusableResult(hit: AnalysisResult, codec: AnalysisResult['codec'], buildId: string, picture: SourcePictureKey, pts: number): boolean {
  try {
    validateResult(hit);
    return hit.confidence === 'exact' && hit.codec === codec && hit.buildId === buildId &&
      hit.recipe === ANALYSIS_RECIPE && hit.analyzerVersion === ANALYZER_VERSION &&
      pictureId(hit.picture) === pictureId(picture) && hit.sourcePtsUs === pts &&
      hit.capabilities.blocks === 'ready' && hit.capabilities.modes === 'ready';
  } catch { return false; }
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
  cached?: (picture: SourcePictureKey) => Promise<AnalysisResult | null>,
) {
  validateRange(target);
  if(typeof core==='function') {
    const factory=core;let instance:Promise<any> | undefined;
    core=()=>instance ??= Promise.resolve().then(factory);
  }
  // Reuse this independent metadata plan across all picture chunks; the
  // decoder session owns its reader and closes it on success or failure.
  const input = await openAnalysisInput(reader, signal, false, {sourceVersion:target.sourceVersion,indexIdentity:target.indexIdentity});
  let first: number;
  const missing = new Set<number>();
  let lastCached: AnalysisResult | undefined;
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
    // Metadata enumerates every expected picture: cached points alone never
    // prove interval coverage. Keep only missing ordinals, not 32 block arrays.
    first = matches[0].pts;
    for (const packet of matches) {
      signal.throwIfAborted();
      const picture = input.picture(packet, target.sourceVersion);
      const hit = await cached?.(picture);
      signal.throwIfAborted();
      const reusable = hit && reusableResult(hit, input.codec, buildId, picture, packet.pts);
      if (hit && reusable) { await onResult(hit); signal.throwIfAborted(); lastCached = hit; }
      else { if (!missing.size) first = packet.pts; missing.add(packet.au); }
    }
    if (!missing.size) { input.close(); return lastCached!; }
    // A factory keeps WASM allocation out of entirely cached range requests.
    if (typeof core === 'function') core = await core();
    signal.throwIfAborted();
  } catch (error) {
    input.close();
    throw error;
  }
  // A bounded interval may span configuration/recovery boundaries. Reopen only
  // decoder state while retaining this independently owned metadata reader.
  let last = lastCached;
  try {
    const groups = groupAnalysisGops(input.packets);
    const segments: number[][] = [];
    for (const packet of input.packets) {
      if (!missing.has(packet.au)) continue;
      const group = gopForAu(groups, packet.au);
      const previous = segments.at(-1);
      const previousGroup = previous && gopForAu(groups, previous[0]);
      if (!previous || previousGroup!.configuration !== group.configuration ||
          input.packets.slice(previous[0] + 1, packet.au + 1).some(p => p.discontinuity)) segments.push([packet.au]);
      else previous.push(packet.au);
    }
    for (const aus of segments) {
      const packet = input.packets[aus[0]];
      last = await analyzePicture(reader, { sourceVersion: target.sourceVersion,
        sourcePtsUs: packet.pts, normalizedMediaUs: Math.max(0, packet.pts - target.firstPtsUs) },
        core, buildId, signal, { input, keepInput: true, desiredAus: new Set(aus), onResult });
    }
    return last!;
  } finally { input.close(); }

}

/** Reconstruct coverage from validated picture chunks; skip only cache-covered
 * groups with a verified safe continuation. Misses retain continuous decode. */
export async function analyzeStream(
  reader: AnalysisReader, target: AnalysisStreamTarget, core: any, buildId: string,
  signal: AbortSignal, onResult: (result: AnalysisResult) => Promise<void>,
  onProgress: (progress: StreamProgress) => Promise<void>,
  frontier?: () => Promise<AnalysisIndexFrontier>,
  cached?: (picture: SourcePictureKey) => Promise<AnalysisResult | null>,
) {
  validateStream(target);
  if (target.window) {
    // Bounded GOP selection needs a sealed metadata index. Keep this wait
    // observable and cancellable; full-film streams still consume sealed prefixes.
    if (frontier) {
      const started = performance.now(); let previous = -1;
      try {
        while (true) {
          signal.throwIfAborted();
          const index = await frontier();
          if (typeof index.complete !== 'boolean' || (index.packets === null ? !index.complete : !Number.isSafeInteger(index.packets) || index.packets < previous || index.packets > 250000))
            throw new AnalysisFailure('incomplete-reference-state', 'Invalid viewport index frontier');
          previous = index.packets ?? previous;
          if (index.complete) break;
          await onProgress({ pictures: 0, totalPictures: null, totalUs: target.window.endUs - target.window.startUs, checkedUs: 0, indexComplete: false, waitingForIndex: true });
          signal.throwIfAborted();
          if (performance.now() - started > 120000) throw new AnalysisFailure('resource-limit', 'Viewport index stalled');
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      } catch (error) { reader.close(); throw error; }
    }
    if (typeof core === 'function') { const factory = core; let instance: Promise<any> | undefined; core = () => instance ??= Promise.resolve().then(factory); }
    const input = await openAnalysisInput(reader, signal, false, { sourceVersion: target.sourceVersion, indexIdentity: target.indexIdentity });
    try {
      const groups = viewportAnalysisGops(input.packets, target.firstPtsUs, target.window);
      const totalPictures = groups.reduce((count, group) => count + group.endAu - group.startAu, 0);
      if (!totalPictures || totalPictures > 250000) throw new AnalysisFailure('resource-limit', 'Empty or oversized analysis viewport');
      const totalUs = target.window.endUs - target.window.startUs;
      let pictures = 0, last: AnalysisResult | undefined;
      const progress = () => onProgress({ pictures, totalPictures, totalUs, checkedUs: pictures === totalPictures ? totalUs : Math.min(totalUs - 1, Math.floor(totalUs * pictures / totalPictures)), indexComplete: true, waitingForIndex: false });
      await progress();
      for (const group of groups) {
        const first = input.packets[group.startAu];
        if (first.size > BUDGET.packetBytes) throw new AnalysisFailure('resource-limit', 'Analysis packet budget exceeded');
        const evidence = inspectPacketPicture(input.codec, input.configurations[group.configuration], await input.readUnit(first));
        group.anchor = evidence.closedRandomAccess ? 'closed' : 'dependent';
        const publish = async (result: AnalysisResult) => {
          last = { ...result, gop: { ...group } };
          await onResult(last); signal.throwIfAborted(); pictures++; await progress();
        };
        const missing = new Set<number>();
        for (let au = group.startAu; au < group.endAu; au++) {
          signal.throwIfAborted();
          const packet = input.packets[au], picture = input.picture(packet, target.sourceVersion), hit = await cached?.(picture);
          if (hit && reusableResult(hit, input.codec, buildId, picture, packet.pts)) await publish(hit);
          else missing.add(au);
        }
        if (missing.size) {
          const packet = input.packets[missing.values().next().value!];
          await analyzePicture(reader, { sourceVersion: target.sourceVersion, sourcePtsUs: packet.pts, normalizedMediaUs: Math.max(0, packet.pts - target.firstPtsUs) }, core, buildId, signal,
            { input, keepInput: true, viewport: true, desiredAus: missing, onResult: publish });
        }
      }
      if (pictures !== totalPictures) throw new AnalysisFailure('incomplete-reference-state', 'Incomplete viewport GOP coverage');
      return last!;
    } finally { input.close(); }
  }
  let latest: StreamProgress = { pictures: 0, totalPictures: 0, checkedUs: 0, totalUs: target.durationUs, indexComplete: false };
  const report = async (progress: StreamProgress) => { latest = progress; await onProgress(progress); };
  const input = await openAnalysisInput(reader, signal, true, {  sourceVersion:target.sourceVersion,indexIdentity:target.indexIdentity,frontier,
    waiting: async waitingForIndex => { await report({ ...latest, waitingForIndex }); } });
  const first = input.packets[0];
  return analyzePicture(reader, { sourceVersion: target.sourceVersion,
    sourcePtsUs: first.pts, normalizedMediaUs: Math.max(0, first.pts - target.firstPtsUs) },
    core, buildId, signal, { input, sequential: true, stream: target, onResult, onProgress: report, cached });
}
