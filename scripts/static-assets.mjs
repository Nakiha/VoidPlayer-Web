import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync, constants } from 'node:zlib';
import path from 'node:path';

const included = name => /\.(wasm|js|css|json|html)$/.test(name) && name !== 'static-assets.json';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function portableGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9 });
  // zlib writes a host-specific OS byte even with a zero timestamp. Use
  // the gzip "unknown" OS value so shared core sidecars match on all platforms.
  compressed[9] = 255;
  return compressed;
}
/** Run after Vite copies public assets; sidecars are build outputs, never runtime work. */
export async function prepareStaticAssets(directory) {
  const assets = {};
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file, name + '/');
      else if (included(name)) {
        const bytes = await readFile(file), variants = {};
        if (bytes.length >= 1024) for (const [encoding, compressed] of [
          ['br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })],
          ['gzip', portableGzip(bytes)],
        ]) {
          if (compressed.length >= bytes.length) continue;
          const suffix = encoding === 'br' ? '.br' : '.gz';
          await writeFile(file + suffix, compressed);
          variants[encoding] = { suffix, sha256: digest(compressed) };
        }
        assets['/' + name] = { sha256: digest(bytes), variants };
      }
    }
  }
  await visit(directory);
  await writeFile(path.join(directory, 'static-assets.json'), JSON.stringify({ version: 1, assets }) + '\n');
}

/** Reject stale or corrupt representations before shipping the package. */
export async function verifyStaticAssets(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'static-assets.json'), 'utf8'));
  if (manifest.version !== 1 || !manifest.assets) throw new Error('Invalid static asset manifest');
  async function coverage(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await coverage(path.join(folder, entry.name), name + '/');
      else if (included(name) && !manifest.assets['/' + name]) throw new Error(`Missing static asset: ${name}`);
    }
  }
  await coverage(directory);
  for (const [name, entry] of Object.entries(manifest.assets)) {
    if (!name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new Error(`Invalid asset path: ${name}`);
    const file = path.join(directory, name.slice(1)), bytes = await readFile(file);
    if (digest(bytes) !== entry.sha256) throw new Error(`Static asset hash mismatch: ${name}`);
    for (const [encoding, variant] of Object.entries(entry.variants ?? {})) {
      const suffix = { br: '.br', gzip: '.gz' }[encoding];
      if (!suffix || variant.suffix !== suffix) throw new Error(`Invalid asset encoding: ${name}`);
      const compressed = await readFile(file + suffix);
      if (digest(compressed) !== variant.sha256 || !(encoding === 'br' ? brotliDecompressSync(compressed) : gunzipSync(compressed)).equals(bytes)) throw new Error(`Static representation mismatch: ${name} (${encoding})`);
    }
  }
}
