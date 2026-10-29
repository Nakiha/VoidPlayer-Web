import assert from 'node:assert/strict';
/** Change only ISO-BMFF clock tables in the committed elementary-stream oracle.
 * Sample bytes, decode order, sync samples and raw-pixel oracles stay identical. */
export function retimeQualityMp4(input, {ticks, timescale}) {
  const bytes = Buffer.from(input);
  let previousDuration, count = 0;
  const boxes = [];
  function walk(start, end) {
    for (let at = start; at < end;) {
      const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
      assert.ok(size >= 8 && at + size <= end);
      boxes.push({at: at + 8, type});
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(at + 8, at + size);
      at += size;
    }
  }
  walk(0, bytes.length);
  for (const {at, type} of boxes) if (type === 'stts') {
    const rows = bytes.readUInt32BE(at + 4);
    for (let i = 0; i < rows; i++) {
      const offset = at + 8 + i * 8, duration = bytes.readUInt32BE(offset + 4);
      previousDuration ??= duration; assert.equal(duration, previousDuration);
      count += bytes.readUInt32BE(offset); bytes.writeUInt32BE(ticks, offset + 4);
    }
  }
  assert.ok(previousDuration && count);
  for (const {at, type} of boxes) {
    if (type === 'mdhd') {
      assert.equal(bytes[at], 0);
      bytes.writeUInt32BE(timescale, at + 12); bytes.writeUInt32BE(count * ticks, at + 16);
    }
    if (type === 'ctts') {
      for (let i = 0; i < bytes.readUInt32BE(at + 4); i++) {
        const offset = at + 12 + i * 8, value = bytes[at] === 1 ? bytes.readInt32BE(offset) : bytes.readUInt32BE(offset);
        assert.equal(value % previousDuration, 0);
        const next = value / previousDuration * ticks;
        if (bytes[at] === 1) bytes.writeInt32BE(next, offset); else bytes.writeUInt32BE(next, offset);
      }
    }
  }
  return bytes;
}
