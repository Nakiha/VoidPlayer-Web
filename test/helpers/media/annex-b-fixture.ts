import { readFile } from 'node:fs/promises';
import { BufferSource, EncodedPacketSink, Input, MP4 } from 'mediabunny';
import type { AnnexBCodec } from '../../../shared/media/codecs/annex-b-picture.ts';
import { readContainerHeader, readNalus } from '../../../shared/media/codecs/configuration-nalus.ts';
import { readMp4Configurations } from '../../../shared/media/containers/mp4-config.ts';
import { RangeReader } from '../../../shared/media/io/range-reader.ts';

export async function annexBFixture(file: string, codec: AnnexBCodec, count = Infinity) {
  const bytes = await readFile(file), input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  const reader = new RangeReader({ file: new Blob([bytes]) });
  const start = Uint8Array.of(0, 0, 0, 1);
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const { descriptions } = await readMp4Configurations(reader, track.id);
    const config = descriptions[0], parts: Uint8Array[] = [], packets: number[] = [];
    for (const nal of readContainerHeader(codec, config).nalus) parts.push(start, config.subarray(nal.offset, nal.offset + nal.size));
    for await (const packet of new EncodedPacketSink(track).packets()) {
      for (const nal of readNalus(codec, config, packet.data)) parts.push(start, packet.data.subarray(nal.offset, nal.offset + nal.size));
      packets.push(packet.timestamp);
      if (packets.length === count) break;
    }
    return { bytes: Buffer.concat(parts), timestamps: packets };
  } finally { input.dispose(); reader.close(); }
}
