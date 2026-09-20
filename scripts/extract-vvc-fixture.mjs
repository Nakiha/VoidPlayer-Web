// Read the pinned VVC MP4 without requiring a system FFmpeg with VVC support.
// Only container tables and packet bytes are read; no video is decoded.
import { readFile } from 'node:fs/promises';
import { Input, BufferSource, MP4, EncodedPacketSink } from 'mediabunny';
import { RangeReader } from '../src/range-reader.ts';
import { readMp4Configurations } from '../src/mp4-config.ts';
const bytes = await readFile(process.argv[2]);
const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
const reader = new RangeReader({ file: new Blob([bytes]) });
try {
  const track = await input.getPrimaryVideoTrack();
  if (!track || !['vvc1', 'vvi1'].includes(await track.getInternalCodecId())) throw Error('Expected VVC MP4 fixture');
  const config = await readMp4Configurations(reader, track.id);
  if (config.descriptions.length !== 1) throw Error('Fixture has multiple decoder configurations');
  const resolution = await track.getTimeResolution(), packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    const i = packets.length;
    packets.push({ pts_time: packet.timestamp, dts_time: packet.timestamp - config.compositionOffsets[i] / resolution,
      flags: packet.type === 'key' ? 'K' : '', data_hex: Buffer.from(packet.data).toString('hex') });
  }
  process.stdout.write(JSON.stringify({ streams: [{ width: await track.getCodedWidth(), height: await track.getCodedHeight(),
    extradata_hex: Buffer.from(config.descriptions[0]).toString('hex') }], packets }));
} finally { input.dispose(); reader.close(); }
