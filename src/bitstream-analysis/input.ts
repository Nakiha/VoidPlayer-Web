import { Input, CustomSource, MP4, QTFF, EncodedPacketSink } from "mediabunny";
import { RangeReader } from "../range-reader.ts";
import { readMp4Configurations } from "../mp4-config.ts";
import { hevcDisplayOrder, recoveredHevcTimes } from "../hevc-timeline.ts";
import { inspectPacketPicture } from "../packet-picture.ts";
import { BUDGET } from "./contract.ts";
import { AnalysisFailure } from "./failure.ts";
import type { AnalysisTarget, SourcePictureKey } from "./contract.ts";
export interface AnalysisReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}
export interface AnalysisPacket {
  au: number;
  configuration: number;
  pts: number;
  dts: number;
  offset: number;
  size: number;
  key: boolean;
}
export async function openAnalysisInput(
  reader: AnalysisReader,
  signal: AbortSignal,
) {
  let bytesRead = 0;
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    if (length > BUDGET.inputBytes || bytesRead + length > 64 * 1024 * 1024)
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
    for await (const packet of sink.packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      signal.throwIfAborted();
      const au = packets.length;
      if (au >= 250000)
        throw new AnalysisFailure(
          "resource-limit",
          "Analysis packet index budget exceeded",
        );
      const offset = configurations.sampleOffsets?.[au],
        size = configurations.sampleSizes?.[au];
      if (offset === undefined || size !== packet.byteLength)
        throw new AnalysisFailure(
          "unsupported-container",
          "Unsupported packet/sample mapping",
        );
      packets.push({
        au,
        configuration: configurations.sampleConfigurations?.[au] ?? 0,
        offset,
        size,
        pts: Math.round(packet.timestamp * 1e6),
        dts: Math.round(
          packet.timestamp * 1e6 -
            (configurations.compositionOffsets![au] / resolution) * 1e6,
        ),
        key: packet.type === "key",
      });
      durations.push(Math.round(packet.duration * 1e6));
    }
    if (
      !packets.length ||
      packets.length !== configurations.sampleSizes?.length
    )
      throw new AnalysisFailure(
        "incomplete-reference-state",
        "Incomplete packet index",
      );
    // Preserve the same verified POC repair as the existing MP4 playback path.
    if (codec === "hevc") {
      const display = await hevcDisplayOrder(
        { size: reader.size, read } as RangeReader,
        configurations,
      );
      const times =
        display &&
        recoveredHevcTimes(
          display,
          packets.map((p) => p.pts),
          durations,
        );
      if (display && !times)
        throw new AnalysisFailure(
          "ambiguous-picture-identity",
          "Unsupported HEVC time mapping",
        );
      if (times)
        packets.forEach((p, i) => {
          p.pts = times[i];
        });
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
      reader,
      read,
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
