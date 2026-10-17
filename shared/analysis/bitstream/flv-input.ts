import { parseFlvIndex } from '../../media/indexing/flv-index-cache.ts';
import { scanFlv, flvIndexIntegrity } from '../../media/containers/flv-demux.ts';
import type { FlvCheckpoint } from '../../media/containers/flv-demux.ts';
import { inspectPacketPicture } from '../../media/codecs/packet-picture.ts';
import { BUDGET } from './contract.ts';
import type { AnalysisTarget, SourcePictureKey } from './contract.ts';
import { AnalysisFailure } from './failure.ts';
import type { AnalysisReader, AnalysisPacket, AnalysisInputOptions } from './types.ts';

/** FLV source ordinals/configurations come from the shared decode-order scanner.
 * No presentation-order numbering and no payload copies in the metadata index. */
export async function openFlvAnalysisInput(reader: AnalysisReader, signal: AbortSignal,
  continuous: boolean, options?: AnalysisInputOptions) {
  let closed = false, bytesRead = 0;
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    if (closed) throw new AnalysisFailure('cancelled', 'Analysis input closed');
    if (length > BUDGET.inputBytes || (!continuous && bytesRead + length > 64 * 1024 * 1024))
      throw new AnalysisFailure('resource-limit', 'Analysis input budget exceeded');
    const bytes = await reader.read(offset, length);
    signal.throwIfAborted();
    bytesRead += bytes.length;
    return bytes;
  };
  let checkpoint: FlvCheckpoint;
  const packets: AnalysisPacket[] = [], configurations: Uint8Array[] = [];
  const byPts = new Map<number, AnalysisPacket | null>();
  let sealedEnd = 0, sourceEndUs = 0, error: unknown;
  let scanComplete = false, admitted = 0, externalComplete = !options?.frontier;
  let lastAdvance = performance.now(), previousFrontier = -1;
  const picture = (packet: AnalysisPacket, version: string): SourcePictureKey => ({
    sourceVersion: version, stream: 'video', configuration: packet.configuration,
    au: packet.au, picture: 0, layer: 0, field: 'frame',
  });
  const commit = (next: FlvCheckpoint) => {
    if (next.index.packets.length > 250000)
      throw new AnalysisFailure('resource-limit', 'Analysis packet index budget exceeded');
    if (next.index.packets.length > packets.length) lastAdvance = performance.now();
    checkpoint = next;
    configurations.splice(0, configurations.length, ...(next.index.configurations ?? [next.index.description]));
    for (let au = packets.length; au < next.index.packets.length; au++) {
      const source = next.index.packets[au];
      const packet: AnalysisPacket = { ...source, au, configuration: source.configuration ?? 0,
        timing: { pts: source.pts / 1000, dts: source.dts / 1000, timebase: [1, 1000] } };
      packets.push(packet);
      byPts.set(packet.pts, byPts.has(packet.pts) ? null : packet);
    }
    sourceEndUs = next.index.firstPts + next.index.duration;
    scanComplete = next.complete;
  };
  const close = () => { if (!closed) { closed = true; reader.close(); } };
  try {
    if (!continuous && reader.flvIndex) {
      const document = await reader.flvIndex();
      signal.throwIfAborted();
      if (document.packets?.length > 250000) throw new AnalysisFailure('resource-limit', 'Analysis packet index budget exceeded');
      commit({ index: parseFlvIndex(document, reader.size), complete: true, nextOffset: reader.size });
    } else {
      // Standalone readers without a shared index pay a full metadata scan.
      // Bound underlying block IO too: a tiny logical scan can touch all bytes.
      if (!continuous && reader.size > 64 * 1024 * 1024)
        throw new AnalysisFailure('resource-limit', 'FLV metadata scan requires a shared index for sources over 64 MiB');
      commit(await scanFlv({ size: reader.size, read }, undefined, undefined, true));
    }
    if (checkpoint!.index.codec === 'av1')
      throw new AnalysisFailure('unsupported-codec', 'AV1 bitstream analysis is not supported');
    const codec = checkpoint!.index.codec as 'h264' | 'hevc' | 'vvc';
    // The scanner publishes validated decode-order prefixes. It runs separately
    // from decoder feeding; neither waiting for an index nor output ACK drains it.
    const scanning = scanComplete ? Promise.resolve() : scanFlv({ size: reader.size, read }, undefined,
      checkpoint!, false, commit).then(commit);
    void scanning.catch(failure => { error = failure; });
    const ensure = async (cursor: number) => {
      while (cursor >= sealedEnd) {
        signal.throwIfAborted();
        if (error) throw error;
        if (options?.frontier) {
          const frontier = await options.frontier();
          if (typeof frontier.complete !== 'boolean' ||
              (frontier.packets === null ? !frontier.complete : !Number.isSafeInteger(frontier.packets) || frontier.packets < previousFrontier || frontier.packets > 250000))
            throw new AnalysisFailure('incomplete-reference-state', 'Invalid FLV index frontier');
          if (frontier.packets !== null && frontier.packets > previousFrontier) {
            previousFrontier = frontier.packets; lastAdvance = performance.now();
          }
          externalComplete = frontier.complete;
          admitted = frontier.packets ?? (scanComplete ? packets.length : 0);
          if (externalComplete && scanComplete && admitted !== packets.length)
            throw new AnalysisFailure('incomplete-reference-state', 'FLV index coverage differs from source');
        } else admitted = packets.length;
        const end = Math.min(packets.length, admitted);
        if (scanComplete && externalComplete && end === packets.length) sealedEnd = end;
        else {
          // Seal only at the next candidate/configuration/discontinuity boundary.
          // The codec still verifies the actual anchor before any restart.
          for (let au = sealedEnd + 1; au < end; au++)
            if (packets[au].key || packets[au].discontinuity || packets[au].configuration !== packets[au - 1].configuration) sealedEnd = au;
        }
        if (cursor < sealedEnd || (scanComplete && externalComplete)) {
          await options?.waiting?.(false);
          return cursor < sealedEnd;
        }
        await options?.waiting?.(true);
        if (performance.now() - lastAdvance > 120000)
          throw new AnalysisFailure('resource-limit', 'FLV index advancement stalled');
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      return true;
    };
    if (!continuous) { await scanning; admitted = packets.length; externalComplete = true; sealedEnd = packets.length; }
    else await ensure(0);
    const readUnit = (packet: AnalysisPacket) => read(packet.offset, packet.size);
    return {
      codec, packets, configurations, reader, read, readUnit, picture,
      ensure: continuous ? ensure : undefined,
      get sealedEnd() { return sealedEnd; },
      get indexComplete() { return scanComplete && externalComplete; },
      get indexIntegrity() { return scanComplete ? flvIndexIntegrity(checkpoint!.index) : undefined; },
      get indexTruncatedAt() { return checkpoint!.index.truncatedAt; },
      // Until both scanners finish, a final count is unknown, not zero/EOF.
      get totalPackets(): number | null { return scanComplete && externalComplete ? packets.length : null; },
      get sourceEndUs() { return sourceEndUs; },
      get bytesRead() { return bytesRead; },
      async plan(target: AnalysisTarget) {
        const packet = byPts.get(target.sourcePtsUs);
        if (!packet || (target.picture && (target.picture.au !== packet.au ||
            target.picture.configuration !== packet.configuration || target.picture.stream !== 'video')))
          throw new AnalysisFailure('ambiguous-picture-identity', 'Missing, ambiguous or mismatched FLV picture');
        let scanned = 0;
        for (let start = packet.au; start >= 0 && packet.au - start < BUDGET.packets; start--) {
          const candidate = packets[start];
          if (candidate.configuration !== packet.configuration) break;
          if (candidate.key) {
            if (candidate.size > BUDGET.packetBytes)
              throw new AnalysisFailure('resource-limit', 'Analysis packet budget exceeded');
            const bytes = await readUnit(candidate); scanned += bytes.length;
            if (scanned > BUDGET.inputBytes)
              throw new AnalysisFailure('resource-limit', 'Analysis planning budget exceeded');
            const evidence = inspectPacketPicture(codec, configurations[candidate.configuration], bytes);
            if (evidence.singlePicture && evidence.closedRandomAccess)
              return { start, target: packet, identity: picture(packet, target.sourceVersion) };
          }
          if (candidate.discontinuity) break;
        }
        throw new AnalysisFailure('no-safe-anchor-within-budget', 'No verified FLV closed anchor within preroll budget');
      },
      close,
    };
  } catch (failure) { close(); throw failure; }
}
