import { access, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyCoreArtifact, playbackFiles, analysisFiles } from './core-artifacts.mjs';
import { readReleaseIdentity, verifyFrontendIdentity } from './release-version.mjs';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'artifacts/sites');
for (const file of ['index.html', 'manifest.webmanifest', 'offline-shell.txt', 'sw.js']) await access(path.join(directory, 'dist', file));
const receipt = JSON.parse(await readFile(path.join(directory, 'sites-build.json'), 'utf8'));
const frontend = JSON.parse(await readFile(path.join(directory, 'dist/build-info.json'), 'utf8'));
const identity = await readReleaseIdentity(root);
verifyFrontendIdentity(frontend, identity);
if (receipt.profile !== 'sites' || receipt.buildId !== frontend.buildId || receipt.revision !== frontend.revision ||
    receipt.sourceDigest !== frontend.sourceDigest) throw new Error('Sites build receipt does not match frontend');
const hosting = JSON.parse(await readFile(path.join(directory, '.openai/hosting.json'), 'utf8'));
if (hosting.project_id || hosting.static?.directory !== 'dist') throw new Error('Portable Sites archive must not carry a registered Site identity');
const cores = {};
for (const [name, schema, files, lockFile] of [
  ['voidplayer-core', 'voidplayer-core-build', playbackFiles, 'release-core.json'],
  ['voidplayer-analysis', 'voidplayer-analysis-build', analysisFiles, 'release-analysis.json'],
]) cores[name] = await verifyCoreArtifact(path.join(directory, 'dist/vendor', name),
  JSON.parse(await readFile(path.join(root, 'scripts', lockFile), 'utf8')), schema, files);
const manifest = { schema: 'voidplayer-sites-release', version: 1, appVersion: identity.version, revision: identity.revision,
  dirty: identity.dirty, tag: identity.tag, decoder: {source: cores['voidplayer-core'].source},
  analysis: {source: cores['voidplayer-analysis'].source}, files: {} };
await rm(path.join(directory, 'sites-release.json'), {force: true});
async function hashFolder(folder, prefix = '') {
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    const name = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) await hashFolder(file, name + '/');
    else manifest.files[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await hashFolder(directory);
await writeFile(path.join(directory, 'sites-release.json'), JSON.stringify(manifest, null, 2) + '\n');
const archive = path.join(root, `artifacts/voidplayer-${identity.version}-sites.tar.gz`);
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-czf', archive, '-C', directory, '.'], { stdio: 'inherit' });
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', checksum + '  ' + path.basename(archive) + '\n');
console.log('Sites static project archive: ' + archive);
