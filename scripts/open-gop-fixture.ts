import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Cut at a non-IDR x264 recovery point, retaining reordered leading pictures. */
export async function openGopFlv(): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vp-open-gop-'));
  try {
    const input = path.join(dir, 'source.mp4'), output = path.join(dir, 'cut.flv');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=30', '-t', '4',
      '-c:v', 'libx264', '-threads', '1', '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=1:bframes=3:b-adapt=0', input], { timeout: 30000 });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', input, '-c', 'copy', '-an', output], { timeout: 30000 });
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
