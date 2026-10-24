import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadPinnedSample } from './pinned-download.ts';

type Sample = {file: string; url: string; size: number; sha256: string};
export type ManifestDocument = {name: string; text: string};
const manifestNames = ['fate-samples.json', 'fate-timestamp-samples.json'];

export async function readFateManifests(): Promise<ManifestDocument[]> {
  return Promise.all(manifestNames.map(async name => ({name,
    text: await readFile(new URL('../' + name, import.meta.url), 'utf8')})));
}

// Include both complete manifests, with their names and boundaries, in the key.
// A transport cache is never evidence of file integrity; every restore is checked.
export function fateManifest(documents: ManifestDocument[]) {
  if (documents.length !== 2 || documents.some((document, i) => document.name !== manifestNames[i]))
    throw new Error('Expected both ordered FATE manifests');
  const samples: Sample[] = [], names = new Set<string>();
  for (const {text} of documents) {
    const entries: unknown = JSON.parse(text);
    if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid FATE manifest');
    for (const entry of entries) {
      if (!entry || typeof entry.file !== 'string' || !/^[\w-][\w.-]*$/.test(entry.file)
        || names.has(entry.file) || !Number.isSafeInteger(entry.size) || entry.size <= 0
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || typeof entry.url !== 'string') throw new Error('Invalid or duplicate FATE sample');
      const url = new URL(entry.url);
      if (url.protocol !== 'https:' || url.host !== 'fate-suite.ffmpeg.org'
        || url.username || url.password || url.search || url.hash) throw new Error('Expected official pinned FATE URL');
      names.add(entry.file); samples.push({file:entry.file,url:entry.url,size:entry.size,sha256:entry.sha256});
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  return {key: 'fate-v1-' + digest, samples};
}

function validateBytes(sample: Sample, bytes: Uint8Array) {
  if (bytes.byteLength !== sample.size || createHash('sha256').update(bytes).digest('hex') !== sample.sha256)
    throw new Error(`${sample.file}: cached/downloaded size or SHA-256 mismatch`);
}
async function verifyFile(directory: string, sample: Sample): Promise<boolean> {
  const path = join(directory, sample.file);
  const info = await lstat(path).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${sample.file}: expected regular FATE file`);
  if (info.size !== sample.size) throw new Error(`${sample.file}: cached size mismatch`);
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== sample.size) throw new Error(`${sample.file}: cached size changed`);
    validateBytes(sample, await handle.readFile());
  } finally { await handle.close(); }
  return true;
}

export async function syncFateFixtures(directory: string, documents: ManifestDocument[], {
  verifyOnly = false, download = downloadPinnedSample,
}: {verifyOnly?: boolean; download?: (sample: Sample) => Promise<Uint8Array>} = {}) {
  const {key, samples} = fateManifest(documents);
  await mkdir(directory, {recursive:true});
  if (!(await lstat(directory)).isDirectory()) throw new Error('Expected regular FATE directory');
  // Check the complete restored set before making any network request. Corrupt
  // entries fail closed instead of silently replacing evidence of a bad cache.
  const missing: Sample[] = [];
  for (const sample of samples) if (!await verifyFile(directory, sample)) missing.push(sample);
  if (verifyOnly && missing.length) throw new Error(`${missing[0].file}: missing pinned FATE sample`);
  for (const sample of missing) {
    const bytes = await download(sample); validateBytes(sample, bytes);
    const temporary = join(directory, '.' + sample.file + '.' + randomUUID() + '.part');
    try {
      const handle = await open(temporary, 'wx');
      try {await handle.writeFile(bytes);} finally {await handle.close();}
      await rename(temporary, join(directory, sample.file));
    } finally {await rm(temporary, {force:true});}
  }
  for (const sample of samples) if (!await verifyFile(directory, sample)) throw new Error(`${sample.file}: missing after preparation`);
  return {key, verified:samples.length, cached:samples.length-missing.length, downloaded:missing.length};
}
