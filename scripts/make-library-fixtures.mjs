// Real decodable media in an exclusively owned test directory. No user library is modified.
// Usage: node scripts/make-library-fixtures.mjs [parent-directory]
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sha256 } from './check-release-set.mjs';

const parent = path.resolve(process.argv[2] || '.run');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'generated-library-'));
const mastersDir = path.join(directory, 'masters'); await mkdir(mastersDir);
const ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe';
const run = (command, args) => execFileSync(command, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const masters = [];
for (const [codec, extension, options] of [
  ['h264', 'mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
  ['ffv1', 'mkv', ['-c:v', 'ffv1', '-pix_fmt', 'yuv444p10le']],
  ['mpeg2video', 'ts', ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-f', 'mpegts']],
]) {
  for (let variant = 0; variant < 3; variant++) {
    const name = `${codec}-${variant}.${extension}`, file = path.join(mastersDir, name);
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=size=${160 + variant * 32}x${96 + variant * 16}:rate=12`, '-t', String(3 + variant), '-vf', `hue=h=${variant * 80}`, ...options, file]);
    // Decode every distinct master, not just the first frame or its container header.
    run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-f', 'null', '-']);
    const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    const bytes = await readFile(file);
    masters.push({ name, codec, size: bytes.length, sha256: sha256(bytes), duration: Number(probe.format.duration), pixelFormat: probe.streams[0].pix_fmt });
  }
}
const roots = [
  { id: 'archive', name: '项目归档', path: 'archive' },
  { id: 'scattered', name: '零散片源', path: 'loose media' },
  { id: 'delivery', name: '交付片源', path: 'delivery' },
];
const entries = [];
async function add(rootId, name, master) {
  const root = roots.find(r => r.id === rootId);
  const target = path.join(directory, root.path, name);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(mastersDir, master.name), target);
  entries.push({ rootId, name, master: master.name, size: master.size, sha256: master.sha256 });
}
for (const root of roots) {
  await add(root.id, 'same-name.mp4', masters[0]);
  for (const master of masters) await add(root.id, `散落片源/${master.name}`, master);
}
let deep = '';
for (let level = 1; level <= 12; level++) {
  deep += `${deep ? '/' : ''}第${level}层`;
  await add('archive', `${deep}/level-${level}.mp4`, masters[level % 3]);
}
// 5,200 independent copies of three generated H.264 masters: modest disk usage,
// every entry is decodable, while exceeding the old 5,000-file cap.
for (let i = 0; i < 5200; i++) {
  const rootId = roots[i % roots.length].id;
  const folder = i < 780 ? '分页目录' : `项目-${i % 17}/批次-${Math.floor(i / 100)}`;
  await add(rootId, `${folder}/clip-${String(i).padStart(5, '0')}.mp4`, masters[i % 3]);
}
const manifest = {
  schema: 'voidplayer-generated-library', version: 1,
  ffmpeg: run(ffmpeg, ['-version']).toString().split('\n')[0],
  masters, roots, entries,
  playback: [{ slot: 'A', rootId: 'archive', name: `${deep}/level-12.mp4` }, { slot: 'B', rootId: 'scattered', name: '散落片源/ffv1-1.mkv' }],
};
await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory, files: entries.length, distinctClips: masters.length, bytes: entries.reduce((sum, e) => sum + e.size, 0), depth: 12 }));
