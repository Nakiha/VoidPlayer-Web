import { mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Each case owns these tiny generated files inside its fixture's temporary
// directory. Only the declared profiles are generated; no shared mutable cache.
export async function prepareAnalysisFixtures(directory, profiles) {
  await mkdir(directory, { recursive: true });
  const needs = name => profiles.includes(name);
  const ff = args => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (needs('depths')) for (const depth of [8, 10]) ff([
    '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=1:duration=1', '-an',
    ...(depth === 8 ? ['-c:v', 'libx264', '-flags', '+ilme+ildct', '-x264-params', 'tff=1:bframes=0']
      : ['-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error:bframes=0']),
    '-pix_fmt', depth === 8 ? 'yuv420p' : 'yuv420p10le', path.join(directory, `depth-${depth}.mp4`),
  ]);
  for (const [profile, file, duration] of [['streams', 'stream', 4], ['incremental', 'incremental', 10]]) if (needs(profile)) ff([
    '-f', 'lavfi', '-i', `testsrc2=size=128x64:rate=30:duration=${duration}`, '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
    '-x264-params', 'scenecut=0:open-gop=0', path.join(directory, `${file}.mp4`),
  ]);
  if (needs('streams')) {
    await copyFile(path.join(directory, 'stream.mp4'), path.join(directory, 'stream-2.mp4'));
    for (const [name, color] of [['bright', 'white'], ['dark', '0x080b12']]) ff([
      '-f', 'lavfi', '-i', `color=${color}:size=640x360:rate=5:duration=1`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(directory, `glass-${name}.mp4`),
    ]);
  }
  if (needs('queues')) for (const name of ['stream.mp4', 'incremental.mp4', 'stream-2.mp4']) await copyFile(path.join(directory, name), path.join(directory, 'queue-' + name));
  if (needs('index-flv')) for (const action of ['continue', 'cancel']) ff(['-i', path.join(directory, 'incremental.mp4'), '-an', '-c:v', 'copy', '-f', 'flv', path.join(directory, `incremental-${action}.flv`)]);
  const references = [];
  if (needs('references')) {
    ff(['-f','lavfi','-i','testsrc2=size=128x64:rate=30:duration=3','-an','-c:v','libx265','-x265-params','pools=1:frame-threads=1:log-level=error:temporal-layers=0:bframes=7:b-adapt=0:keyint=60:min-keyint=60:scenecut=0',path.join(directory,'hevc-reference.mp4')]);
    references.push('hevc-reference.mp4');
    if (process.env.ANALYSIS_REFERENCE_SAMPLE) {
      await copyFile(process.env.ANALYSIS_REFERENCE_SAMPLE, path.join(directory, 'user-reference.mp4'));
      references.push('user-reference.mp4');
    }
  }
  return references;
}
