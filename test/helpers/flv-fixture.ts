function tag(type: number, payload: Uint8Array, time = 0) {
  const b = Buffer.alloc(15 + payload.length); b[0] = type; b.writeUIntBE(payload.length, 1, 3); b.writeUIntBE(time & 0xffffff, 4, 3); b[7] = time >>> 24;
  b.set(payload, 11); b.writeUInt32BE(payload.length + 11, 11 + payload.length); return b;
}
export function syntheticFlv() {
  const config = tag(9, new Uint8Array([0x17, 0, 0, 0, 0, 1, 100, 0, 31, 0xff, 0xe0, 0]));
  const video = (time: number, key: boolean) => tag(9, new Uint8Array([key ? 0x17 : 0x27, 1, 0, 0, 0, 0, 0, 0, 1, 9]), time);
  return Buffer.concat([Buffer.from([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]), config,
    video(0, true), video(40, false), video(80, true), tag(8, new Uint8Array(1024 * 1024)), video(120, false)]);
}

