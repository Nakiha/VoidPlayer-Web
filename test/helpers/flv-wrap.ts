export function flvTag(payload: Uint8Array, dts: number) {
  const tag = Buffer.alloc(payload.length + 15); tag[0] = 9; tag.writeUIntBE(payload.length, 1, 3);
  tag.writeUIntBE(dts & 0xffffff, 4, 3); tag[7] = dts >>> 24; tag.set(payload, 11); tag.writeUInt32BE(payload.length + 11, tag.length - 4); return tag;
}
export function wrapFlv(codec: 'h264' | 'hevc', configuration: Uint8Array, packets: Uint8Array[], enhanced = false, origin = 2000) {
  const header = (type: number, pts: number, dts: number) => {
    const cts = Buffer.alloc(3); cts.writeUIntBE((pts - dts) & 0xffffff, 0, 3);
    return enhanced ? Buffer.concat([Buffer.from([0x90 | type]), Buffer.from(codec === 'h264' ? 'avc1' : 'hvc1'), ...(type === 1 ? [cts] : [])])
      : Buffer.concat([Buffer.from([codec === 'h264' ? 0x17 : 0x1c, type]), cts]);
  };
  return Buffer.concat([Buffer.from('464c5601010000000900000000', 'hex'), flvTag(Buffer.concat([header(0, 0, 0), configuration]), 0),
    ...packets.map((bytes, i) => flvTag(Buffer.concat([header(1, origin + i * 1000, origin + i * 1000), bytes]), origin + i * 1000))]);
}
