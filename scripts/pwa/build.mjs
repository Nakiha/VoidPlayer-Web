import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../static-assets.mjs';

export function isPlayerAsset(name) {
  return /^assets\/.*\.(js|css)$/.test(name) && !/^assets\/(admin|connection-guide)-/.test(name)
    || /^assets\/(favicon|apple-touch-icon)-[^/]+\.(ico|svg|png)$/.test(name);
}

export async function writePlayerWorker(directory, chunks, coreDigests, {sites = false} = {}) {
  const manifestFile = path.join(directory, 'manifest.webmanifest');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const assets = {};
  // Installed Chrome apps discover new icons through changes to the manifest's icon URLs.
  for (const icon of manifest.icons) {
    const pathname = new URL(icon.src, 'https://localhost/').pathname;
    const hash = digest(await readFile(path.join(directory, pathname)));
    icon.src = pathname + '?v=' + hash;
    assets[icon.src] = hash;
  }
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const shellPath = sites ? '/offline-shell.txt' : '/index.html';
  // Static hosts may redirect index.html or rewrite HTML responses. Publish the
  // exact shell bytes as a text asset that the worker serves for navigation.
  if (sites) await writeFile(path.join(directory, shellPath), await readFile(path.join(directory, 'index.html')));
  const files = [shellPath, '/theme-init.js', '/startup-guard.js', '/manifest.webmanifest', '/icon-foreground.svg', ...chunks.map(file => '/' + file)];
  for (const file of [...new Set(files)].sort()) {
    assets[file] = digest(await readFile(path.join(directory, file)));
  }
  for (const [file, hash] of Object.entries(coreDigests).sort()) {
    if (file === '/vendor/voidplayer-analysis/threading.json'
      || /\/(voidplayer-(?:core|analysis)(?:-mt)?\.(?:js|wasm)|manifest\.json)$/.test(file)) assets[file + '?v=' + hash] = hash;
  }
  const integrity = Object.fromEntries(Object.entries(assets).map(([url, hash]) => [url, 'sha256-' + Buffer.from(hash, 'hex').toString('base64')]));
  const { buildId } = JSON.parse(await readFile(path.join(directory, 'build-info.json'), 'utf8'));
  const worker = await readFile(new URL('worker.js', import.meta.url), 'utf8');
  const inventory = JSON.stringify(integrity);
  const revision = digest(worker + inventory);
  await writeFile(path.join(directory, 'sw.js'), `const revision = '${revision}';\nconst buildId = ${JSON.stringify(buildId ?? '')};\n` +
    `const assets = ${inventory};\nconst shellPath = ${JSON.stringify(shellPath)};\n${worker}`);
}
