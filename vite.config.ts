import { FRONTEND_ENTRIES, FRONTEND_HTML_INPUTS } from './scripts/frontend-entries.mjs';
import { isPlayerAsset, writePlayerWorker } from './scripts/pwa/build.mjs';
import { prepareStaticAssets, verifyStaticAssets } from './scripts/static-assets.mjs';
import { lowerDescriptors } from './scripts/testing/i18n-transform.mjs';
import { defineConfig, normalizePath } from 'vite';
import { readBuildIdentity } from './scripts/release-version.mjs';
import { sealFrontend } from './server/frontend-releases.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const buildId = randomUUID();
const sourceDir = resolve(import.meta.dirname, 'src');
let englishCatalogRef = '';
let buildCatalog = false;
const infoFile = resolve(sourceDir, 'build-info.ts');
let publicDirectory = resolve(import.meta.dirname, 'public');
const coreDir = () => resolve(publicDirectory, 'vendor/voidplayer-core');
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
  hashSources(sourceDir, 'src/');
  hashSources(resolve(import.meta.dirname, 'shared'), 'shared/');
  for (const file of ['package-lock.json', 'vite.config.ts', ...FRONTEND_HTML_INPUTS, 'public/theme-init.js', 'public/startup-guard.js']) hash.update(file).update(readFileSync(resolve(import.meta.dirname, file)));
  const wasmDigests = Object.fromEntries(['voidplayer-core.wasm', 'voidplayer-core-mt.wasm'].map(name => {
    try { return [name, createHash('sha256').update(readFileSync(resolve(coreDir(), name))).digest('hex')]; }
    catch { return [name, null]; }
  }));
  const coreAssetDigests: Record<string, string> = {};
  for (const folder of ['voidplayer-core', 'voidplayer-analysis']) {
    const directory = resolve(publicDirectory, 'vendor', folder);
    try { for (const name of readdirSync(directory)) if (/\.(js|wasm|json)$/.test(name))
      coreAssetDigests[`/vendor/${folder}/${name}`] = createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex'); } catch {}
  }
  return { ...identity, buildId, coreAssetDigests, builtAt: new Date().toISOString(), sourceDigest: hash.digest('hex'), wasmDigests };
}
let playerAssets: string[] = [];
let outputDirectory = resolve(import.meta.dirname, 'dist');
let productionBuildInfo: ReturnType<typeof buildInfo> | undefined;
const transformBuildInfo = async (_code: string, id: string) => {
  if (normalizePath(id.split('?')[0]) === normalizePath(infoFile)) return { code: `export const buildInfo = ${JSON.stringify(await (productionBuildInfo ?? buildInfo()))}`, map: null };
};
export default defineConfig(({ mode }) => {
  const sites = mode === 'sites';
  const entries = sites ? { player: FRONTEND_ENTRIES.player } : FRONTEND_ENTRIES;
  const htmlInputs = Object.values(entries);
  return {
  // Vite builds Worker entrypoints in a separate plugin pipeline. Their WASM
  // URLs must use the same content versions as the main-thread glue URLs.
  worker: { plugins: () => [{ name: 'voidplayer-worker-build-evidence', transform: transformBuildInfo }] },
  build: { rollupOptions: { input: Object.fromEntries(Object.entries(entries).map(([name,file]) => [name,resolve(import.meta.dirname,file)])) } },
  plugins: [{ name: 'voidplayer-i18n-catalog-url', enforce: 'pre',
    configResolved(config) { buildCatalog = config.command === 'build'; outputDirectory = resolve(config.root, config.build.outDir); publicDirectory = config.publicDir; },
    buildStart() { if(buildCatalog) englishCatalogRef=this.emitFile({type:'chunk',id:resolve(sourceDir,'i18n/generated/en.js'),name:'en'}); },
    transform(code,id) {
      if(normalizePath(id.split('?')[0])!==normalizePath(resolve(sourceDir,'i18n.ts')))return;
      return {code:code.replace("'__EN_CATALOG_URL__'",englishCatalogRef ? `import.meta.ROLLUP_FILE_URL_${englishCatalogRef}` : "'/src/i18n/generated/en.js'"),map:null};
    },
  }, { name: 'voidplayer-i18n-descriptors', enforce: 'pre', transform: lowerDescriptors }, {
    name: 'voidplayer-dev-favicon',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/(href="[^"?]*\/)(favicon\.(?:ico|svg))\?no-inline"/g, (_match, prefix, file) => {
        const version = createHash('sha256').update(readFileSync(resolve(publicDirectory, file))).digest('hex').slice(0, 16);
        return `${prefix}${file}?no-inline&v=${version}"`;
      });
    },
  }, {
    name: 'voidplayer-admin-entry',
    configureServer(server) {
      if (sites) return;
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
    transformIndexHtml: { order: 'post', handler(html, context) {
      const bundle = context.bundle;
      if (!bundle || context.path !== '/index.html') return;
      const entry = Object.values(bundle).find(chunk => chunk.type === 'chunk'
        && normalizePath(chunk.facadeModuleId ?? '').endsWith('/src/main.ts'));
      if (!entry) throw new Error('Player startup chunk missing');
      const files = new Set<string>();
      function visit(file: string) {
        const chunk = bundle![file];
        if (!chunk || chunk.type !== 'chunk' || files.has(file)) return;
        files.add(file);
        for (const dependency of chunk.imports) visit(dependency);
      }
      visit(entry.fileName);
      const urls = [...files].map(file => '/' + file).filter(url => !html.includes(`href="${url}"`));
      // Fetch/compile only: bootstrap still selects the language before evaluating main.
      // The HTTP connection guide must never preload the player graph.
      return [{ tag: 'meta', attrs: { name: 'voidplayer-offline-shell', content: 'player' }, injectTo: 'head' },
        { tag: 'script', attrs: { 'data-startup-preload': '' }, injectTo: 'head',
        children: `if(globalThis.isSecureContext&&location.pathname!=='/connection'){for(const href of ${JSON.stringify(urls)}){const link=document.createElement('link');link.rel='modulepreload';link.crossOrigin='anonymous';link.href=href;document.head.append(link);}}` }];
    } },
    generateBundle(_options, bundle) {
      playerAssets = Object.keys(bundle).filter(isPlayerAsset);
    },
    async closeBundle() {
      if (!productionBuildInfo) return;
      // Classic bootstrap scripts run before the module graph. Pin them to the HTML that selected them.
      for (const file of ['theme-init.js', 'startup-guard.js']) {
        const bytes = await readFile(resolve(outputDirectory, file));
        const versioned = 'assets/' + file.replace('.js', '-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.js');
        await writeFile(resolve(outputDirectory, versioned), bytes);
        playerAssets.push(versioned);
        for (const entry of htmlInputs) {
          const target = resolve(outputDirectory, entry), html = await readFile(target, 'utf8');
          await writeFile(target, html.replace('src="/' + file + '"', 'src="/' + versioned + '"'));
        }
      }
      if (sites) {
        await rm(resolve(outputDirectory, 'manifest.webmanifest'), { force: true });
        return;
      }
      await writePlayerWorker(outputDirectory, playerAssets, (await productionBuildInfo).coreAssetDigests);
      await prepareStaticAssets(outputDirectory);
      await verifyStaticAssets(outputDirectory);
      await sealFrontend(outputDirectory);
    },
    async buildStart() {
      productionBuildInfo = buildCatalog ? buildInfo() : undefined;
      if (productionBuildInfo) this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(await productionBuildInfo, null, 2) + '\n' });
    },
    transform: transformBuildInfo,
    handleHotUpdate({ file, server }) {
      if (normalizePath(file).startsWith(normalizePath(sourceDir)) || normalizePath(file).startsWith(normalizePath(resolve(import.meta.dirname, 'shared'))) || normalizePath(file).startsWith(normalizePath(coreDir()))) {
        const module = server.moduleGraph.getModuleById(infoFile);
        if (module) server.moduleGraph.invalidateModule(module);
      }
    },
  }],
  server: {
    // Generated failure HTML must not reload unrelated browser harnesses.
    watch: { ignored: ['**/.run/**', '**/artifacts/**'] },
    proxy: sites ? undefined : { '/api': { target: 'http://127.0.0.1:5180', changeOrigin: false } },
    headers: sites ? {} : isolationHeaders,
  },
  };
});
