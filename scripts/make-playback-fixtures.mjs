// Synthetic performance inputs, separate from the upstream codec QA samples.
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const directory = path.resolve('.run/playback-media');
await mkdir(directory, { recursive: true });
const first = path.join(directory, 'http-1080p-a.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '40', '-an',
  '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-b:v', '20M', '-minrate', '20M', '-maxrate', '20M', '-bufsize', '20M',
  '-g', '60', '-bf', '2', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-movflags', '+faststart', first], { stdio: 'inherit', timeout: 180000 });
await copyFile(first, path.join(directory, 'http-1080p-b.mp4'));
console.log(`Generated 1080p30 H.264, 40 s, ${(await stat(first)).size} bytes per track`);
