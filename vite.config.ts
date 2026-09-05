import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const sourceDir = resolve(import.meta.dirname, 'src');
const infoFile = resolve(sourceDir, 'build-info.ts');
const coreDir = resolve(import.meta.dirname, 'public/vendor/voidplayer-core');
function buildInfo() {
  let revision = 'unknown';
  try { revision = execFileSync('git', ['describe', '--always', '--dirty'], { encoding: 'utf8' }).trim(); } catch { /* Archive without Git. */ }
  const hash = createHash('sha256');
  for (const name of readdirSync(sourceDir).sort()) {
    if (/\.(ts|css)$/.test(name)) hash.update(name).update(readFileSync(resolve(sourceDir, name)));
  }
  hash.update(readFileSync(resolve(import.meta.dirname, 'package-lock.json')));
  const wasmDigests = Object.fromEntries(['voidplayer-core.wasm', 'voidplayer-core-mt.wasm'].map(name => {
    try { return [name, createHash('sha256').update(readFileSync(resolve(coreDir, name))).digest('hex')]; }
    catch { return [name, null]; }
  }));
  return { revision, builtAt: new Date().toISOString(), sourceDigest: hash.digest('hex'), wasmDigests };
}
export default defineConfig({
  plugins: [{
    name: 'voidplayer-build-evidence',
    transform(code, id) {
      if (id.split('?')[0] === infoFile) return { code: `export const buildInfo = ${JSON.stringify(buildInfo())}`, map: null };
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(sourceDir) || file.startsWith(coreDir)) {
        const module = server.moduleGraph.getModuleById(infoFile);
        if (module) server.moduleGraph.invalidateModule(module);
      }
    },
  }],
  server: {
    proxy: { '/api': 'http://127.0.0.1:5180' },
    headers: {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    },
  },
});
