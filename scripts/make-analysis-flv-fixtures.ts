import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { openAnalysisInput } from '../src/bitstream-analysis/input.ts';
import { inspectPacketPicture } from '../src/packet-picture.ts';

// Remux byte-identical codec inputs into both supported FLV framings. The
// original independent codec answers stay applicable by source decode ordinal.
const matrix = JSON.parse(await readFile('scripts/bitstream-analysis-matrix.json', 'utf8'));
await mkdir('fixtures/flv-analysis', { recursive: true });
const u24 = (n: number) => Buffer.from([(n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const tag = (bytes: Uint8Array, dts: number) => {
  const footer = Buffer.alloc(4); footer.writeUInt32BE(bytes.length + 11);
  return Buffer.concat([Buffer.from([9]), u24(bytes.length), u24(dts), Buffer.from([dts >>> 24]), Buffer.alloc(3), bytes, footer]);
};
for (const row of matrix.rows.filter((r: any) => r.container === 'mp4')) {
  const data = await readFile(`fixtures/video/${row.fixture}`);
  const input = await openAnalysisInput({ size: data.length,
    async read(offset, length) { return data.subarray(offset, offset + length); }, close() {} }, new AbortController().signal);
  for (const enhanced of [false, true]) {
    const framing = enhanced ? 'enhanced' : 'legacy';
    const header = Buffer.from('464c5601010000000900000000', 'hex');
    const config = (id: number) => tag(enhanced
      ? Buffer.concat([Buffer.from([0x90]), Buffer.from({ h264: 'avc1', hevc: 'hvc1', vvc: 'vvc1' }[input.codec]), input.configurations[id]])
      : Buffer.concat([Buffer.from([0x10 | { h264: 7, hevc: 12, vvc: 14 }[input.codec], 0, 0, 0, 0]), input.configurations[id]]), 0);
    // These QA clips are 60 fps. Use a monotonic decode clock and source
    // presentation deltas; some legacy MP4 ctts unsigned values are malformed.
    const parts = [header, config(0)], repeated = [header, config(0)], damaged = [header, config(0)];
    let changed = false, damagedOnce = false;
    for (const packet of input.packets) {
      const bytes = await input.readUnit(packet), pts = Math.round((packet.pts - input.packets[0].pts) / 1000) + 2000, dts = Math.round(packet.au * 1000 / 60) + 2000;
      const payload = enhanced
        ? Buffer.concat([Buffer.from([(packet.key ? 0x90 : 0xa0) | 1]), Buffer.from({ h264: 'avc1', hevc: 'hvc1', vvc: 'vvc1' }[input.codec]), u24(pts - dts), bytes])
        : Buffer.concat([Buffer.from([(packet.key ? 0x10 : 0x20) | { h264: 7, hevc: 12, vvc: 14 }[input.codec], 1]), u24(pts - dts), bytes]);
      const encoded = tag(payload, dts);
      if (!changed && packet.au > 60 && inspectPacketPicture(input.codec, input.configurations[0], bytes).closedRandomAccess) {
        // Valid avcC/hvcC/vvcC with a different parameter-set ordering is not
        // universal; duplicate config plus damage exercises same-config reset.
        repeated.push(config(0)); changed = true;
      }
      if (!damagedOnce && packet.au > 60 && inspectPacketPicture(input.codec, input.configurations[0], bytes).closedRandomAccess) {
        damaged.push(Buffer.alloc(17, 0xff), config(0)); damagedOnce = true;
      }
      parts.push(encoded); repeated.push(encoded); damaged.push(encoded);
    }
    const name = `${framing}-${input.codec}`;
    await writeFile(`fixtures/flv-analysis/${name}.flv`, Buffer.concat(parts));
    await writeFile(`fixtures/flv-analysis/${name}-tail.flv`, Buffer.concat([...parts, Buffer.from('truncated-tail')]));
    if (damagedOnce) await writeFile(`fixtures/flv-analysis/${name}-gap.flv`, Buffer.concat(damaged));
    await writeFile(`fixtures/flv-analysis/${name}-sequence.flv`, Buffer.concat(repeated));
    console.log(`${name}: ${input.packets.length} AUs`);
  }
  input.close();
}
