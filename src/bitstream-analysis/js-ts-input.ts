import { TsPacketSource, tsPictureStream, parseTsPacketIndex, retainVerifiedTsIndex, TsSourceChangedError } from '../ts-packet-source.ts';
import { inspectPacketPicture } from '../packet-picture.ts';
import { pictureId, BUDGET } from './contract.ts';
import type { SourcePictureKey } from './contract.ts';
import type { AnalysisReader, AnalysisInput, AnalysisPacket } from './types.ts';
import { AnalysisFailure } from './failure.ts';

/** Independent packet source; shared semantics never borrow a playback cursor. */
export async function openJsTsAnalysisInput(reader: AnalysisReader, sourceVersion: string, signal: AbortSignal, cached?: unknown): Promise<AnalysisInput> {
  const source = new TsPacketSource(reader, sourceVersion, signal);
  try {
    signal.throwIfAborted();
    const restored = parseTsPacketIndex(cached, sourceVersion, reader.size);
    const reusable = restored ? retainVerifiedTsIndex(restored) : undefined;
    const index = reusable ?? await source.open();
    signal.throwIfAborted();
    let opened = !reusable;
    let opening: Promise<void> | undefined;
    const configuration = Uint8Array.from(index.configuration);
    const packets: AnalysisPacket[] = index.packets.map(packet => ({ au: packet.au, configuration: packet.configuration,
      pts: packet.ptsUs, dts: packet.timing.dts === null ? null : Math.round(packet.timing.dts * 1e6 / 90000),
      // Opaque locator, readUnit below never performs a byte-range read at it.
      offset: packet.locator, size: packet.size, key: packet.key, timing: packet.timing }));
    const picture = (packet: AnalysisPacket, version: string): SourcePictureKey => {
      if (version !== sourceVersion) throw new AnalysisFailure('source-changed', 'JS packet source version mismatch');
      return { sourceVersion: version, stream: tsPictureStream(index), configuration: 0, au: packet.au, picture: 0, layer: 0, field: 'frame' };
    };
    const readUnit = async (packet: AnalysisPacket) => {
      if (!opened) await (opening ??= source.open(index).then(() => {
        if (!source.indexReused) {source.close();throw new AnalysisFailure('source-changed', 'Cached JS packet index no longer matches source');}
        opened = true;
      }).catch(error=>{source.close();if(error instanceof TsSourceChangedError)throw new AnalysisFailure('source-changed',error.message);throw error;}));
      return source.readUnit(packet.au);
    };
    return { rawTiming: true, codec: 'h264', configurations: [configuration], packets, sealedEnd: packets.length,
      indexComplete: true, indexIntegrity: 'complete', totalPackets: packets.length,
      sourceEndUs: index.packets.reduce((end,p)=>Math.max(end,p.ptsUs+p.durationUs),0), reader,
      read: (offset, length) => reader.read(offset, length), readUnit, picture,
      get bytesRead() { return source.bytesRead; }, close() { source.close(); },
      async plan(target) {
        if (target.sourceVersion !== sourceVersion) throw new AnalysisFailure('source-changed', 'JS packet source version mismatch');
        const packet = packets.find(p => p.pts === target.sourcePtsUs);
        if (!packet || packet.timing?.pts == null || target.picture && pictureId(target.picture) !== pictureId(picture(packet, sourceVersion)))
          throw new AnalysisFailure('ambiguous-picture-identity', 'JS packet target mismatch');
        for (let start = packet.au; start >= 0 && packet.au - start < BUDGET.packets; start--) {
          if (!packets[start].key) continue;
          const evidence = inspectPacketPicture('h264', configuration, await readUnit(packets[start]));
          if (evidence.singlePicture && evidence.closedRandomAccess) return { start, target: packet, identity: picture(packet, sourceVersion) };
        }
        throw new AnalysisFailure('no-safe-anchor-within-budget', 'No verified JS TS IDR within preroll budget');
      },
    };
  } catch (error) { source.close(); throw error; }
}
