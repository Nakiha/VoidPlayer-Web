import { lowerDescriptors } from './scripts/testing/i18n-transform.mjs';
import { defineConfig, normalizePath } from 'vite';
import { readBuildIdentity } from './scripts/release-version.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const sourceDir = resolve(import.meta.dirname, 'src');
let englishCatalogRef = '';
let buildCatalog = false;
const infoFile = resolve(sourceDir, 'build-info.ts');
const coreDir = resolve(import.meta.dirname, 'public/vendor/voidplayer-core');
const isolationHeaders = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};
async function buildInfo() {
  const identity = await readBuildIdentity(import.meta.dirname);
  const hash = createHash('sha256');
  // UI and themes now live in subdirectories. Build evidence must include
  // them as well as the top-level decoding/session modules.
  function hashSources(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) hashSources(resolve(directory, entry.name), `${relative}/`);
      else if (/\.(ts|js|mjs|css)$/.test(entry.name)) hash.update(relative).update(readFileSync(resolve(directory, entry.name)));
    }
  }
  hashSources(sourceDir);
  for (const file of ['package-lock.json', 'index.html', 'admin/index.html', 'public/theme-init.js', 'public/startup-guard.js']) hash.update(file).update(readFileSync(resolve(import.meta.dirname, file)));
  const wasmDigests = Object.fromEntries(['voidplayer-core.wasm', 'voidplayer-core-mt.wasm'].map(name => {
    try { return [name, createHash('sha256').update(readFileSync(resolve(coreDir, name))).digest('hex')]; }
    catch { return [name, null]; }
  }));
  return { ...identity, builtAt: new Date().toISOString(), sourceDigest: hash.digest('hex'), wasmDigests };
}
let productionBuildInfo: ReturnType<typeof buildInfo> | undefined;
export default defineConfig({
  build: { rollupOptions: { input: { player: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin/index.html') } } },
  plugins: [{ name: 'voidplayer-i18n-catalog-url', enforce: 'pre',
    configResolved(config) { buildCatalog = config.command === 'build'; },
    buildStart() { if(buildCatalog) englishCatalogRef=this.emitFile({type:'chunk',id:resolve(sourceDir,'i18n/generated/en.js'),name:'en'}); },
    transform(code,id) {
      if(normalizePath(id.split('?')[0])!==normalizePath(resolve(sourceDir,'i18n.ts')))return;
      return {code:code.replace("'__EN_CATALOG_URL__'",englishCatalogRef ? `import.meta.ROLLUP_FILE_URL_${englishCatalogRef}` : "'/src/i18n/generated/en.js'"),map:null};
    },
  }, { name: 'voidplayer-i18n-descriptors', enforce: 'pre', transform: lowerDescriptors }, {
    name: 'voidplayer-admin-entry',
    configureServer(server) {
      // Vite's conditional module responses bypass server.headers. WebKit
      // validates isolation on those 304s too, including shared Worker imports.
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(isolationHeaders)) res.setHeader(name, value);
        next();
      });
      // Vite only resolves directory index.html for paths ending in a slash.
      // Match the packaged server's /admin route before the SPA fallback.
      server.middlewares.use((req, _res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/admin' || url.pathname === '/admin/') req.url = `/admin/index.html${url.search}`;
        next();
      });
    },
  }, {
    name: 'voidplayer-build-evidence',
    async buildStart() {
      productionBuildInfo = buildCatalog ? buildInfo() : undefined;
      if (productionBuildInfo) this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(await productionBuildInfo, null, 2) + '\n' });
    },
    async transform(code, id) {
      if (normalizePath(id.split('?')[0]) === normalizePath(infoFile)) return { code: `export const buildInfo = ${JSON.stringify(await (productionBuildInfo ?? buildInfo()))}`, map: null };
    },
    handleHotUpdate({ file, server }) {
      if (normalizePath(file).startsWith(normalizePath(sourceDir)) || normalizePath(file).startsWith(normalizePath(coreDir))) {
        const module = server.moduleGraph.getModuleById(infoFile);
        if (module) server.moduleGraph.invalidateModule(module);
      }
    },
  }],
  server: {
    // Generated failure HTML must not reload unrelated browser harnesses.
    watch: { ignored: ['**/.run/**', '**/artifacts/**'] },
    proxy: { '/api': { target: 'http://127.0.0.1:5180', changeOrigin: false } },
    headers: isolationHeaders,
  },
});
