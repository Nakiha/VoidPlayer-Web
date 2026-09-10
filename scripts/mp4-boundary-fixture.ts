import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Small video, real 9 MiB moov, 64-bit mdat declaration beyond EOF.
 * Retain all samples and adjust stco offsets after padding the moov. */
export async function mp4BoundaryFixture(bFrames = 0, co64 = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-mp4-bounds-'));
  try {
    const file = path.join(dir, 'source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=10', '-t', '2',
      '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-g', '10', '-bf', String(bFrames), '-movflags', '+faststart', file]);
    let bytes: Buffer = await readFile(file);
    const padding = 9 * 1024 * 1024;
    if (co64) bytes = widenOffsets(bytes);
    let moov = -1, free = -1, mdat = -1;
    for (let at = 0; at < bytes.length; at += bytes.readUInt32BE(at)) {
      const type = bytes.toString('ascii', at + 4, at + 8);
      if (type === 'moov') moov = at;
      if (type === 'free') free = at;
      if (type === 'mdat') mdat = at;
    }
    if (moov < 0 || mdat !== free + 8 || moov > mdat) throw new Error('unexpected generated MP4 layout');
    const end = moov + bytes.readUInt32BE(moov);
    const patch = (start: number, end: number) => {
      for (let at = start; at < end; at += bytes.readUInt32BE(at)) {
        const type = bytes.toString('ascii', at + 4, at + 8), size = bytes.readUInt32BE(at);
        if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) patch(at + 8, at + size);
        if (type === 'co64') for (let i = 0; i < bytes.readUInt32BE(at + 12); i++) {
          const p = at + 16 + i * 8; bytes.writeBigUInt64BE(bytes.readBigUInt64BE(p) + BigInt(padding), p);
        }
        if (type === 'stco') for (let i = 0; i < bytes.readUInt32BE(at + 12); i++) {
          const p = at + 16 + i * 4; bytes.writeUInt32BE(bytes.readUInt32BE(p) + padding, p);
        }
      }
    };
    patch(moov + 8, end); bytes.writeUInt32BE(bytes.readUInt32BE(moov) + padding, moov);
    const extra = Buffer.alloc(padding); extra.writeUInt32BE(padding); extra.write('free', 4);
    // Reuse the preceding 8-byte free box for largesize, leaving payload offsets unchanged.
    bytes.writeUInt32BE(1, free); bytes.write('mdat', free + 4); bytes.writeBigUInt64BE(BigInt(bytes.length - free), free + 8);
    const valid = Buffer.concat([bytes.subarray(0, end), extra, bytes.subarray(end)]);
    const oversized = Buffer.from(valid); oversized.writeBigUInt64BE(14260000000n, free + padding + 8);
    return { valid, oversized, moov, mdat: free + padding };
  } finally { await rm(dir, { recursive: true, force: true }); }
}


/** Rebuild nested box sizes and relocate media when widening chunk offsets. */
function widenOffsets(source: Buffer): Buffer {
  let growth = 0;
  const rebuild = (data: Buffer, delta: number): Buffer => {
    const parts: Buffer[] = [];
    for (let at = 0; at < data.length;) {
      const size = data.readUInt32BE(at), type = data.toString('ascii', at + 4, at + 8);
      let box = Buffer.from(data.subarray(at, at + size));
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        box = Buffer.concat([box.subarray(0, 8), rebuild(box.subarray(8), delta)]);
        box.writeUInt32BE(box.length);
      } else if (type === 'stco') {
        const count = box.readUInt32BE(12), original = box;
        growth += count * 4; box = Buffer.alloc(16 + count * 8);
        original.copy(box, 0, 0, 16); box.writeUInt32BE(box.length); box.write('co64', 4);
        for (let i = 0; i < count; i++) box.writeBigUInt64BE(BigInt(original.readUInt32BE(16 + i * 4) + delta), 16 + i * 8);
      }
      parts.push(box); at += size;
    }
    return Buffer.concat(parts);
  };
  rebuild(source, 0);
  return rebuild(source, growth);
}
