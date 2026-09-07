import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function resolutionFlv(codec = 'h264', sizes = ['320x180', '640x360'], sar = '1'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-resolution-'));
  try {
    const parts: Buffer[] = [];
    for (const [i, size] of sizes.entries()) {
      const file = path.join(dir, `${i}.flv`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10`, '-t', '1', '-an', '-vf', `setsar=${sar}`,
        '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-threads', '1', '-preset', 'ultrafast', '-g', '10', '-bf', '2',
        ...(codec === 'hevc' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error'] : []), '-f', 'flv', file], { timeout: 30000 });
      const bytes = await readFile(file);
      if (i === 0) parts.push(bytes.subarray(0, 13));
      for (let p = 13; p + 15 <= bytes.length;) {
        const end = p + 15 + bytes.readUIntBE(p + 1, 3);
        const tag = Buffer.from(bytes.subarray(p, end));
        if (tag[0] === 9) {
          const time = tag.readUIntBE(4, 3) + tag[7] * 0x1000000 + i * 1000;
          tag.writeUIntBE(time & 0xffffff, 4, 3); tag[7] = time >>> 24; parts.push(tag);
        }
        p = end;
      }
    }
    return Buffer.concat(parts);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function prerollMp4(codec = 'hevc'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-preroll-'));
  try {
    const source = path.join(dir,'source.mp4'), cut = path.join(dir,'cut.mp4');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','4','-an','-c:v',codec === 'hevc' ? 'libx265' : 'libx264','-preset','ultrafast',...(codec === 'hevc' ? ['-x265-params','pools=1:frame-threads=1:log-level=error:keyint=20:open-gop=1','-tag:v','hvc1'] : ['-x264-params','keyint=20:open-gop=1','-bf','2']),source],{timeout:30000});
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss','0.7','-i',source,'-t','2','-c','copy',cut],{timeout:30000});
    return await readFile(cut);
  } finally { await rm(dir,{recursive:true,force:true}); }
}
