import { Input, CustomSource, MP4, QTFF, EncodedPacketSink } from "mediabunny";
import type { AnalysisReader, AnalysisPacket, AnalysisInputOptions } from "./types.ts";
import { RangeReader } from "../range-reader.ts";
import { readMp4Configurations } from "../mp4-config.ts";
import { hevcDisplayOrder, recoveredHevcTimes } from "../hevc-timeline.ts";
import { inspectPacketPicture } from "../packet-picture.ts";
import type { AnalysisIndexFrontier } from "./stream.ts";
import { BUDGET } from "./contract.ts";
import { AnalysisFailure } from "./failure.ts";
import type { AnalysisTarget, SourcePictureKey } from "./contract.ts";
export async function openMp4AnalysisInput(
  reader: AnalysisReader,
  signal: AbortSignal,
  continuous = false,
  streamIndex?: AnalysisInputOptions,
) {
  let bytesRead = 0;
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    if (length > BUDGET.inputBytes || (!continuous && bytesRead + length > 64 * 1024 * 1024))
      throw new AnalysisFailure(
        "resource-limit",
        "Analysis input budget exceeded",
      );
    const b = await reader.read(offset, length);
    signal.throwIfAborted();
    bytesRead += b.length;
    return b;
  };
  const input = new Input({
    source: new CustomSource({
      getSize: () => reader.size,
      read: (start, end) => read(start, end - start),
      maxCacheSize: 1024 * 1024,
    }),
    formats: [MP4, QTFF],
  });
  try {
    try {
      await input.getFormat();
    } catch (error) {
      if (error instanceof AnalysisFailure || signal.aborted) throw error;
      throw new AnalysisFailure(
        "unsupported-container",
        "Only progressive MP4 is admitted for bitstream analysis",
      );
    }
    const track = await input.getPrimaryVideoTrack();
    if (!track)
      throw new AnalysisFailure("unsupported-codec", "No video stream");
    if (streamIndex?.frontier && (await input.getVideoTracks()).length !== 1)
      throw new AnalysisFailure('ambiguous-picture-identity', 'Incremental analysis requires an unambiguous video stream');
    const id = await track.getInternalCodecId(),
      known = await track.getCodec();
    const codec: "h264" | "hevc" | "vvc" | null =
      id === "vvc1" || id === "vvi1"
        ? "vvc"
        : known === "avc"
          ? "h264"
          : known === "hevc"
            ? "hevc"
            : null;
    if (!codec)
      throw new AnalysisFailure(
        "unsupported-codec",
        "Unsupported analysis codec",
      );
    const configurations = await readMp4Configurations(
      { size: reader.size, read } as RangeReader,
      track.id,
      250000,
      true,
    );
    if (configurations.indexIntegrity === "prefix")
      throw new AnalysisFailure(
        "incomplete-reference-state",
        "Incomplete source: exact analysis unsupported",
      );
    const packets: AnalysisPacket[] = [],
      durations: number[] = [],
      resolution = await track.getTimeResolution();
    const sink = new EncodedPacketSink(track);
    const iterator = sink.packets(undefined, undefined, { metadataOnly: true })[Symbol.asyncIterator]();
    let indexComplete = false, sealedEnd = 0, sourceEndUs = 0;
    const expectedPackets = configurations.sampleSizes!.length;
    let frontier: AnalysisIndexFrontier = streamIndex?.frontier ? { packets: 0, complete: false } : { packets: null, complete: true };
    let lastAdvance = performance.now(), previousFrontier = -1;
    const append = async () => {
      signal.throwIfAborted();
      const au = packets.length;
      if (streamIndex?.frontier && !frontier.complete && au >= (frontier.packets ?? 0)) {
        for (;;) {
          frontier = await streamIndex.frontier();
          signal.throwIfAborted();
          if (typeof frontier.complete !== 'boolean' || (frontier.packets !== null && (!Number.isSafeInteger(frontier.packets) || frontier.packets < previousFrontier || frontier.packets > expectedPackets)) ||
              (frontier.packets === null && !frontier.complete))
            throw new AnalysisFailure('incomplete-reference-state', 'Invalid index frontier');
          if (frontier.packets !== null && frontier.packets > previousFrontier) { previousFrontier = frontier.packets; lastAdvance = performance.now(); }
          if (frontier.complete && frontier.packets !== null && frontier.packets !== expectedPackets)
            throw new AnalysisFailure('incomplete-reference-state', 'Index does not cover the complete MP4 sample table');
          if (frontier.complete || (frontier.packets !== null && au < frontier.packets)) break;
          await streamIndex.waiting?.(true);
          signal.throwIfAborted();
          if (performance.now() - lastAdvance > 120000)
            throw new AnalysisFailure('resource-limit', 'Index advancement stalled');
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 200);
            signal.addEventListener('abort', abort, { once: true });
          });
        }
        await streamIndex.waiting?.(false);
      }
      const next = await iterator.next();
      if (next.done) {
        if (!packets.length || packets.length !== expectedPackets)
          throw new AnalysisFailure('incomplete-reference-state', 'Incomplete packet index');
        indexComplete = true;
        return false;
      }
      const packet = next.value;
      if (au >= 250000) throw new AnalysisFailure('resource-limit', 'Analysis packet index budget exceeded');
      const offset = configurations.sampleOffsets?.[au], size = configurations.sampleSizes?.[au];
      if (offset === undefined || size !== packet.byteLength)
        throw new AnalysisFailure('unsupported-container', 'Unsupported packet/sample mapping');
      packets.push({ au, configuration: configurations.sampleConfigurations?.[au] ?? 0, offset, size,
        pts: Math.round(packet.timestamp * 1e6),
        dts: Math.round(packet.timestamp * 1e6 - (configurations.compositionOffsets![au] / resolution) * 1e6), key: packet.type === 'key',
        timing: { pts: configurations.decodeTimes ? configurations.decodeTimes[au] + configurations.compositionOffsets![au] : null, dts: configurations.decodeTimes?.[au] ?? null, timebase: [1, resolution] } });
      durations.push(Math.round(packet.duration * 1e6));
      sourceEndUs = Math.max(sourceEndUs, Math.round((packet.timestamp + packet.duration) * 1e6));
      return true;
    };
    const canRepairHevc = codec === "hevc" && configurations.descriptions.length === 1 && !configurations.compositionOffsets!.some(n => n !== 0);
    const repair = async (start: number, end: number) => {
      // POC repair is confined to a sealed GOP. Never publish timestamps which
      // might be revised when another index batch arrives.
      if (!canRepairHevc) return;
      const display = await hevcDisplayOrder({ read } as RangeReader, { ...configurations,
        sampleOffsets: configurations.sampleOffsets!.slice(start, end),
        sampleSizes: configurations.sampleSizes!.slice(start, end),
        compositionOffsets: configurations.compositionOffsets!.slice(start, end) });
      const group = packets.slice(start, end);
      const times = display && recoveredHevcTimes(display, group.map(p => p.pts), durations.slice(start, end));
      if (display && !times) throw new AnalysisFailure('ambiguous-picture-identity', 'Unsupported HEVC time mapping');
      if (times) group.forEach((p, i) => { p.pts = times[i]; });
    };
    const timestamps = new Set<number>();
    const ensure = async (cursor: number) => {
      while (cursor >= sealedEnd && !indexComplete) {
        const start = sealedEnd;
        if (packets.length === start) await append();
        while (!indexComplete) {
          if (!await append()) break;
          const p = packets.at(-1)!;
          if (p.au > start && (p.key || p.configuration !== packets[start].configuration)) break;
          // Yield metadata enumeration even for very long GOPs.
          if (!(packets.length % 128)) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        sealedEnd = indexComplete ? packets.length : packets.length - 1;
        await repair(start, sealedEnd);
        for (let i = start; i < sealedEnd; i++) {
          if (timestamps.has(packets[i].pts)) throw new AnalysisFailure('ambiguous-picture-identity', 'Duplicate picture timestamps');
          timestamps.add(packets[i].pts);
        }
      }
      return cursor < sealedEnd;
    };
    if (streamIndex) await ensure(0);
    else {
      while (await append()) {}
      await repair(0, packets.length);
      sealedEnd = packets.length;
    }
    const byPts = new Map<number, AnalysisPacket | null>();
    for (const p of packets) byPts.set(p.pts, byPts.has(p.pts) ? null : p);
    const picture = (p: AnalysisPacket, version: string): SourcePictureKey => ({
      sourceVersion: version,
      stream: "video",
      configuration: p.configuration,
      au: p.au,
      picture: 0,
      layer: 0,
      field: "frame",
    });
    return {
      codec,
      configurations: configurations.descriptions,
      packets,
      ensure: streamIndex ? ensure : undefined,
      get sealedEnd() { return sealedEnd; },
      get indexComplete() { return indexComplete; },
      indexIntegrity: configurations.indexIntegrity,
      indexTruncatedAt: configurations.indexTruncatedAt,
      totalPackets: expectedPackets,
      get sourceEndUs() { return sourceEndUs; },
      reader,
      read,
      readUnit: (packet: AnalysisPacket) => read(packet.offset, packet.size),
      get bytesRead() {
        return bytesRead;
      },
      picture,
      async plan(target: AnalysisTarget) {
        const p = byPts.get(target.sourcePtsUs);
        if (!p)
          throw new AnalysisFailure(
            "ambiguous-picture-identity",
            "Missing or ambiguous source timestamp",
          );
        if (
          target.picture &&
          (target.picture.au !== p.au ||
            target.picture.configuration !== p.configuration ||
            target.picture.stream !== "video")
        )
          throw new AnalysisFailure(
            "ambiguous-picture-identity",
            "Picture identity mismatch",
          );
        let start = p.au,
          scanned = 0;
        for (; start >= 0 && p.au - start < BUDGET.packets; start--) {
          signal.throwIfAborted();
          const candidate = packets[start];
          if (candidate.configuration !== p.configuration) break;
          if (!candidate.key) continue;
          if (candidate.size > BUDGET.packetBytes)
            throw new AnalysisFailure(
              "resource-limit",
              "Analysis packet budget exceeded",
            );
          const bytes = await read(candidate.offset, candidate.size);
          scanned += bytes.length;
          if (scanned > BUDGET.inputBytes)
            throw new AnalysisFailure(
              "resource-limit",
              "Analysis planning budget exceeded",
            );
          const evidence = inspectPacketPicture(
            codec,
            configurations.descriptions[p.configuration],
            bytes,
          );
          if (evidence.singlePicture && evidence.closedRandomAccess)
            return {
              start,
              target: p,
              identity: picture(p, target.sourceVersion),
            };
        }
        throw new AnalysisFailure(
          "no-safe-anchor-within-budget",
          "No verified closed random access point within preroll budget",
        );
      },
      close() {
        void iterator.return?.();
        input.dispose();
        reader.close();
      },
    };
  } catch (error) {
    input.dispose();
    reader.close();
    throw error;
  }
}
