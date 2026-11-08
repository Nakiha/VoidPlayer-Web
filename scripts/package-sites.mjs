import { access, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyCoreArtifact, playbackFiles, analysisFiles } from './core-artifacts.mjs';

const root = path.resolve(import.meta.dirname, '..');
await access(path.join(root, 'artifacts/sites/dist/index.html'));
const directory = path.join(root, 'artifacts/sites');
const receipt = JSON.parse(await readFile(path.join(directory, 'sites-build.json'), 'utf8'));
const frontend = JSON.parse(await readFile(path.join(directory, 'dist/build-info.json'), 'utf8'));
if (receipt.profile !== 'sites' || receipt.buildId !== frontend.buildId) throw new Error('Sites build receipt does not match frontend');
for (const [name, schema, files, lockFile] of [
  ['voidplayer-core', 'voidplayer-core-build', playbackFiles, 'release-core.json'],
  ['voidplayer-analysis', 'voidplayer-analysis-build', analysisFiles, 'release-analysis.json'],
]) await verifyCoreArtifact(path.join(directory, 'dist/vendor', name),
  JSON.parse(await readFile(path.join(root, 'scripts', lockFile), 'utf8')), schema, files);
const archive = path.join(root, 'artifacts/voidplayer-sites.tar.gz');
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-czf', archive, '-C', directory, '.'], { stdio: 'inherit' });
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', checksum + '  ' + path.basename(archive) + '\n');
console.log('Sites static project archive: ' + archive);
