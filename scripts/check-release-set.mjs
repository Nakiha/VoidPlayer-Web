// Aggregate only artifacts from one successful workflow run, never rebuild here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseIdentity, readReleaseNotes } from './release-version.mjs';

export const releasePlatforms = ['linux-x64', 'windows-x64', 'darwin-arm64'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function verifyReleaseSet(directory, identity, { bunVersion, coreSource }) {
  const files = (await readdir(directory)).sort();
  const archives = files.filter(name => name.endsWith('.tar.gz'));
  assert.equal(archives.length, releasePlatforms.length, 'one archive per supported platform');
  assert.equal(files.filter(name => name.endsWith('.sha256')).length, archives.length, 'one checksum per archive');
  const assets = [], platforms = new Set();
  let sharedCore;
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  for (const name of archives) {
    assert.match(name, /^voidplayer-[0-9A-Za-z.-]+\.tar\.gz$/);
    const archive = path.join(directory, name), bytes = await readFile(archive);
    const checksum = await readFile(archive + '.sha256');
    assert.equal(checksum.toString().trim(), `${sha256(bytes)}  ${name}`, `archive checksum: ${name}`);
    const manifest = JSON.parse(execFileSync(tar, ['-xOf', archive, `${name.slice(0, -7)}/release.json`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
    assert.equal(manifest.schema, 'voidplayer-release'); assert.equal(manifest.version, 2);
    assert.equal(manifest.appVersion, identity.version, 'version matches selected ref');
    assert.equal(manifest.revision, identity.revision, 'all platforms use the same selected revision');
    assert.equal(manifest.dirty, false, 'CI builds must be clean');
    const platform = manifest.target?.replace(/^bun-/, '');
    assert.ok(releasePlatforms.includes(platform) && !platforms.has(platform), 'supported platform, no duplicates');
    assert.equal(manifest.target, `bun-${platform}`);
    assert.ok(name.startsWith(`voidplayer-${identity.version}-${platform}`));
    if (identity.tag) assert.equal(name, `voidplayer-${identity.version}-${platform}.tar.gz`);
    platforms.add(platform);
    assert.deepEqual(manifest.runtime, { name: 'bun', version: bunVersion });
    assert.deepEqual(manifest.decoder?.source, coreSource, 'decoder source matches lock');
    const coreHashes = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name.startsWith('dist/vendor/voidplayer-core/')).sort(([a], [b]) => a.localeCompare(b)));
    for (const file of ['voidplayer-core.js', 'voidplayer-core.wasm', 'voidplayer-core-mt.js', 'voidplayer-core-mt.wasm', 'provenance.json', 'LICENSES/COPYING.LGPLv2.1', 'LICENSES/dav1d-COPYING']) assert.match(coreHashes[`dist/vendor/voidplayer-core/${file}`] ?? '', /^[a-f0-9]{64}$/, file);
    if (sharedCore) assert.deepEqual(coreHashes, sharedCore, 'all platforms ship identical decoder bytes and provenance');
    else sharedCore = coreHashes;
    for (const [assetName, contents] of [[name, bytes], [name + '.sha256', checksum]]) assets.push({ name: assetName, bytes: contents.length, sha256: sha256(contents) });
  }
  return { schema: 'voidplayer-release-set', version: 1, appVersion: identity.version, revision: identity.revision, tag: identity.tag, platforms: [...platforms].sort(), assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const identity = await readReleaseIdentity(root);
  assert.equal(identity.dirty, false, 'aggregate from a clean checkout');
  const directory = path.resolve(process.argv[2] || 'artifacts/release-set');
  const report = await verifyReleaseSet(directory, identity, { bunVersion: (await readFile(path.join(root, '.bun-version'), 'utf8')).trim(), coreSource: JSON.parse(await readFile(path.join(root, 'scripts/release-core.json'), 'utf8')) });
  await writeFile(path.join(directory, 'release-set.json'), JSON.stringify(report, null, 2) + '\n');
  const notes = await readReleaseNotes(root, identity);
  if (notes) await writeFile(path.join(directory, 'release-notes.md'), notes);
  console.log(`PASS release set: ${report.appVersion}; ${report.platforms.join(', ')}; ${report.assets.length} checked assets`);
}
