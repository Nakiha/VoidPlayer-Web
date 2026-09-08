import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Small video, real 9 MiB moov, 64-bit mdat declaration beyond EOF.
 * Retain all samples and adjust stco offsets after padding the moov. */
export async function mp4BoundaryFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-mp4-bounds-'));
  try {
    const file = path.join(dir, 'source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=10', '-t', '2',
      '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-g', '10', '-bf', '0', '-movflags', '+faststart', file]);
    const bytes = await readFile(file), padding = 9 * 1024 * 1024;
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
