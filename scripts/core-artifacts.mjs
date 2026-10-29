import {verifyCoreCapabilities} from './core-capabilities.mjs';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const playbackFiles = ['voidplayer-core.js', 'voidplayer-core.wasm', 'voidplayer-core-mt.js', 'voidplayer-core-mt.wasm', 'LICENSES/COPYING.LGPLv2.1', 'LICENSES/dav1d-COPYING', 'capabilities.json', 'capabilities-mt.json', 'voidplayer-ffmpeg-manifest.json', 'voidplayer-ffmpeg-manifest-mt.json'];
export const analysisFiles = ['voidplayer-analysis.js', 'voidplayer-analysis.wasm', 'manifest.json', 'LICENSE', 'LICENSE.libvmaf', 'LICENSE.libsvm', 'capabilities.json'];
export async function verifyCoreArtifact(directory, lock, schema, required) {
  const provenance = JSON.parse(await readFile(path.join(directory, 'provenance.json'), 'utf8'));
  assert.equal(provenance.schema, schema, 'Core provenance schema');
  assert.deepEqual(provenance.source, lock, 'Core source differs from release lock');
  assert.ok(!provenance.dirty, 'Unpublished core cannot be packaged');
  for (const name of required) assert.match(provenance.files?.[name] ?? '', /^[a-f0-9]{64}$/, `Missing core hash: ${name}`);
  for (const [name, hash] of Object.entries(provenance.files)) {
    assert.ok(name && !path.isAbsolute(name) && !name.includes('\\') && !name.split('/').some(part => ['..', '.', ''].includes(part)), 'Unsafe core manifest path');
    const file = path.join(directory, name);
    assert.ok((await lstat(file)).isFile(), `Core asset is not a regular file: ${name}`);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Core bytes differ from provenance: ${name}`);
  }
  if (schema === 'voidplayer-analysis-build') {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    for (const key of ['repository', 'revision', 'ffmpegRepository', 'ffmpegRevision', 'abi', 'semanticVersion', 'referenceAbi', 'demuxAbi', 'qualityAbi'])
      assert.equal(manifest[key], lock[key], `Analysis manifest ${key} differs from release lock`);
    assert.ok(!manifest.dirty, 'Unpublished analysis manifest');
    assert.equal(provenance.buildId, manifest.buildId ?? manifest.revision, 'Analysis build ID differs');
    assert.equal(provenance.referenceAbi, lock.referenceAbi, 'Analysis reference ABI differs');
  }
  if(lock.capabilityAbi===1){if(schema==='voidplayer-analysis-build')await verifyCoreCapabilities(directory,lock,'analysis');else for(const suffix of ['', '-mt'])await verifyCoreCapabilities(directory,lock,'playback',suffix);}
  return provenance;
}

/** Stage the complete selected variant set; never leave an older MT/provenance behind. */
export async function syncPlaybackCore(source, target, lock) {
  source = path.resolve(source); target = path.resolve(target);
  assert.notEqual(source, target, 'Core source and destination must differ');
  const exists = async name => !!await lstat(name).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const prepared = await exists(path.join(source, 'provenance.json'));
  if (prepared) await verifyCoreArtifact(source, lock, 'voidplayer-core-build', playbackFiles);
  const sibling = path.join(path.dirname(source), `voidplayer-ffmpeg-wasm-mt-${lock.ffmpegRef}`);
  const multi = prepared || await exists(path.join(source, 'voidplayer-core-mt.js')) || await exists(path.join(source, 'voidplayer-core-mt.wasm')) ? source : sibling;
  const hasMulti = await exists(path.join(multi, 'voidplayer-core-mt.js')) || await exists(path.join(multi, 'voidplayer-core-mt.wasm'));
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(target), '.core-sync-'));
  const staged = path.join(temporary, 'new'), backup = path.join(temporary, 'old');
  let preserveBackup = false;
  try {
    await mkdir(staged);
    for (const suffix of hasMulti ? ['', '-mt'] : ['']) for (const extension of ['js', 'wasm']) {
      const name = `voidplayer-core${suffix}.${extension}`;
      await cp(path.join(suffix ? multi : source, name), path.join(staged, name));
    }
    for(const suffix of hasMulti?['','-mt']:[''])for(const name of [`capabilities${suffix}.json`,`voidplayer-ffmpeg-manifest${suffix}.json`]){
      const folder=prepared?source:suffix?multi:source;
      const sourceName=!prepared&&suffix&&name===`voidplayer-ffmpeg-manifest${suffix}.json`?'voidplayer-ffmpeg-manifest.json':name;
      if(await exists(path.join(folder,sourceName)))await cp(path.join(folder,sourceName),path.join(staged,name));
    }
    if (await exists(path.join(source, 'LICENSES'))) await cp(path.join(source, 'LICENSES'), path.join(staged, 'LICENSES'), { recursive: true });
    if (prepared) {
      await cp(path.join(source, 'provenance.json'), path.join(staged, 'provenance.json'));
      await verifyCoreArtifact(staged, lock, 'voidplayer-core-build', playbackFiles);
    }
    const hadTarget = await exists(target);
    if (hadTarget) await rename(target, backup);
    try { await rename(staged, target); }
    catch (error) {
      if (hadTarget) try { await rename(backup, target); }
      catch (restoreError) {
        preserveBackup = true;
        throw new AggregateError([error, restoreError], `Core restore failed; original files retained at ${backup}`);
      }
      throw error;
    }
    console.log(`Synced ${source} -> ${target} (${hasMulti ? 'ST + MT' : 'ST only; no stale MT'}, ${prepared ? 'verified provenance' : 'local unpinned build'})`);
  } finally { if (!preserveBackup) await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(import.meta.dirname, '..');
  const lock = JSON.parse(await readFile(path.join(root, 'scripts/release-core.json'), 'utf8'));
  await syncPlaybackCore(process.argv[2], process.argv[3] ?? path.join(root, 'public/vendor/voidplayer-core'), lock);
}
