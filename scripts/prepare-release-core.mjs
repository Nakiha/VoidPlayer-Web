// Assemble upstream outputs; decoder source/build logic stays in its own repository.
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.argv[2]);
const target = path.resolve(process.argv[3] ?? path.join(root, 'public/vendor/voidplayer-core'));
const lock = JSON.parse(await readFile(path.join(root, 'scripts/release-core.json'), 'utf8'));
for (const [folder, revision] of [[source, lock.revision], [path.join(source, '.build/sources/ffmpeg-wasm'), lock.ffmpegRevision], [path.join(source, '.build/sources/dav1d-wasm'), lock.dav1dRevision]]) {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: folder, encoding: 'utf8' }).trim(), revision, folder);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: folder, encoding: 'utf8' }).trim(), '', `Dirty decoder sources: ${folder}`);
}
await mkdir(target, { recursive: true });
const single = path.join(source, 'dist', `voidplayer-ffmpeg-wasm-${lock.ffmpegRef}`);
const multi = path.join(source, 'dist', `voidplayer-ffmpeg-wasm-mt-${lock.ffmpegRef}`);
for (const suffix of ['', '-mt']) for (const ext of ['js', 'wasm']) {
  const file = `voidplayer-core${suffix}.${ext}`;
  await cp(path.join(suffix ? multi : single, file), path.join(target, file));
}
await cp(path.join(single, 'LICENSES'), path.join(target, 'LICENSES'), { recursive: true });
const files = {};
async function hashes(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await hashes(path.join(folder, entry.name), name + '/');
    else if (name !== 'provenance.json') files[name] = createHash('sha256').update(await readFile(path.join(folder, entry.name))).digest('hex');
  }
}
await hashes(target);
await writeFile(path.join(target, 'provenance.json'), JSON.stringify({ schema: 'voidplayer-core-build', version: 1, source: lock, buildRun: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, files }, null, 2) + '\n');
console.log(`Prepared core from ${lock.revision}: ${target}`);
