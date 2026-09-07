import { readFile } from 'node:fs/promises';
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, EncodedVideoPacketSource, Output, Mp4OutputFormat, BufferTarget } from 'mediabunny';

/** Remux the pinned 1080p HEVC sample, without decoding, transcoding, another
 * downloaded fixture, or a system FFmpeg dependency in the unit tests. */
export async function packetFixture(name: string): Promise<Uint8Array<ArrayBuffer>> {
  if (name !== 'hevc-packet-1080p.mp4') return readFile(new URL(`../fixtures/video/${name}`, import.meta.url));
  const bytes = await readFile(new URL('../fixtures/video/mhw_x265_aq_qg16_4s_1920x1080.mkv', import.meta.url));
  const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || await track.getCodec() !== 'hevc') throw new Error('Pinned HEVC fixture has no HEVC video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('Pinned HEVC fixture has no decoder configuration');
    const source = new EncodedVideoPacketSource('hevc'); output.addVideoTrack(source);
    await output.start();
    for await (const packet of new EncodedPacketSink(track).packets()) await source.add(packet, { decoderConfig: config });
    await output.finalize();
    return new Uint8Array(target.buffer!);
  } finally { input.dispose(); }
}
