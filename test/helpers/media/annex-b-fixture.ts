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

/** user_data_unregistered SEI, with a payload spanning the probe's first block. */
export function withLeadingSei(bytes: Uint8Array, codec: AnnexBCodec) {
  const header = { h264: [6], hevc: [39 << 1, 1], vvc: [0, (23 << 3) | 1] }[codec];
  const size = 300 * 1024, sizeField = Buffer.alloc(Math.floor(size / 255) + 1, 255);
  sizeField[sizeField.length - 1] = size % 255;
  return Buffer.concat([Buffer.from([0, 0, 0, 1, ...header, 5]), sizeField, Buffer.alloc(size, 0x55), Buffer.of(0x80), bytes]);
}
