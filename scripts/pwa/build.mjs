import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../static-assets.mjs';

export async function writePlayerWorker(directory, chunks, coreDigests) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.webmanifest'), 'utf8'));
  const files = ['/index.html', '/theme-init.js', '/startup-guard.js', '/manifest.webmanifest', '/favicon.ico', '/favicon.svg',
    '/apple-touch-icon.png', ...manifest.icons.map(icon => icon.src), ...chunks.map(file => '/' + file)];
  const assets = {};
  for (const file of [...new Set(files)].sort()) {
    assets[file] = digest(await readFile(path.join(directory, file)));
  }
  for (const [file, hash] of Object.entries(coreDigests).sort()) {
    if (/\/(voidplayer-(?:core|analysis)(?:-mt)?\.(?:js|wasm)|manifest\.json)$/.test(file)) assets[file + '?v=' + hash] = hash;
  }
  const integrity = Object.fromEntries(Object.entries(assets).map(([url, hash]) => [url, 'sha256-' + Buffer.from(hash, 'hex').toString('base64')]));
  const worker = await readFile(new URL('worker.js', import.meta.url), 'utf8');
  const inventory = JSON.stringify(integrity);
  const revision = digest(worker + inventory);
  await writeFile(path.join(directory, 'sw.js'), `const revision = '${revision}';\nconst assets = ${inventory};\n${worker}`);
}
