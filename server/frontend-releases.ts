import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, realpath, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StaticAssets } from './static-assets.ts';

const catalogName = 'frontend-release.json';
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type Catalog = { buildId: string; files: Record<string, string> };
type Entry = { buildId: string; publishedAt: number; retiredAt?: number };
type Index = { releases: Entry[]; bundled?: string };

async function readIndex(store: string): Promise<Index> {
  try {
    const index = JSON.parse(await readFile(path.join(store, 'current.json'), 'utf8'));
    if (!Array.isArray(index.releases) || !index.releases.length || !index.releases.every((r: Entry) =>
      idPattern.test(r.buildId) && Number.isFinite(r.publishedAt) && (r.retiredAt === undefined || Number.isFinite(r.retiredAt)))) throw new Error('Invalid frontend publication index');
    if (index.bundled && !index.releases.some((entry: Entry) => entry.buildId === index.bundled)) throw new Error('Missing bundled frontend release');
    return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { releases: [] };
    throw error;
  }
}

async function fileDigests(root: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (name === catalogName) continue;
    if (entry.isDirectory()) Object.assign(files, await fileDigests(root, name + '/'));
    else if (entry.isFile()) files[name] = hash(await readFile(path.join(root, name)));
    else throw new Error('Unsupported frontend asset: ' + name);
  }
  return files;
}

function legacyId(files: Catalog['files']) {
  const id = hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).slice(0, 32);
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

async function validateCatalog(root: string, { buildId, files }: Catalog) {
  const { buildId: embeddedId, coreAssetDigests } = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
  if (!idPattern.test(buildId) || (embeddedId ?? legacyId(files)) !== buildId) throw new Error('Invalid frontend build ID');
  for (const name of ['index.html', 'admin/index.html', 'static-assets.json', 'sw.js', 'manifest.webmanifest']) {
    if (!files[name]) throw new Error('Missing frontend entry: ' + name);
  }
  for (const [url, digest] of Object.entries(coreAssetDigests)) {
    if (files[url.slice(1)] !== digest) throw new Error('Decoder changed during build: ' + url);
  }
  const staticManifest = JSON.parse(await readFile(path.join(root, 'static-assets.json'), 'utf8'));
  if (staticManifest.version !== 1 || !staticManifest.assets) throw new Error('Invalid static asset manifest');
  for (const [url, asset] of Object.entries(staticManifest.assets) as [string, { sha256: string; variants: Record<string, { suffix: string; sha256: string }> }][]) {
    if (files[url.slice(1)] !== asset.sha256) throw new Error('Static asset mismatch: ' + url);
    for (const variant of Object.values(asset.variants)) {
      if (files[url.slice(1) + variant.suffix] !== variant.sha256) throw new Error('Static representation mismatch: ' + url);
    }
  }
  const worker = await readFile(path.join(root, 'sw.js'), 'utf8');
  const inventory = JSON.parse(/^const assets = (.*);$/m.exec(worker)?.[1] ?? '');
  for (const [url, integrity] of Object.entries(inventory)) {
    const digest = files[new URL(url, 'http://localhost').pathname.slice(1)];
    if (!digest || 'sha256-' + Buffer.from(digest, 'hex').toString('base64') !== integrity) throw new Error('Offline inventory mismatch: ' + url);
  }
  for (const entry of ['index.html', 'admin/index.html']) {
    const html = await readFile(path.join(root, entry), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      if (!Object.hasOwn(files, match[1].slice(1))) throw new Error('Missing HTML dependency: ' + match[1]);
    }
  }
}

/** Seal the complete build only after HTML, offline inventory and all representations exist. */
export async function sealFrontend(root: string) {
  const { buildId } = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
  const catalog = { buildId, files: await fileDigests(root) };
  await validateCatalog(root, catalog);
  await writeFile(path.join(root, catalogName), JSON.stringify(catalog) + '\n');
}

async function readCatalog(root: string): Promise<Catalog> {
  const catalog = JSON.parse(await readFile(path.join(root, catalogName), 'utf8'));
  if (!idPattern.test(catalog.buildId) || !catalog.files || typeof catalog.files !== 'object') throw new Error('Invalid frontend catalog');
  for (const [name, digest] of Object.entries(catalog.files)) {
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\0]/.test(name)
      || name === catalogName || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid frontend asset: ' + name);
  }
  return catalog;
}

async function candidateCatalog(source: string): Promise<Catalog> {
  try { return await readCatalog(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const info = JSON.parse(await readFile(path.join(source, 'build-info.json'), 'utf8'));
  if (info.buildId !== undefined) throw new Error('Incomplete frontend build: missing ' + catalogName);
  const files = await fileDigests(source);
  const catalog = { buildId: legacyId(files), files };
  await validateCatalog(source, catalog);
  return catalog;
}

function sameFiles(a: Catalog['files'], b: Catalog['files']) {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, digest]) => b[name] === digest);
}

export async function verifyFrontendBuild(root: string) {
  const catalog = await readCatalog(root), files = await fileDigests(root);
  if (!sameFiles(files, catalog.files)) throw new Error('Incomplete frontend build: ' + root);
  await validateCatalog(root, catalog);
}

async function installSnapshot(source: string, store: string, catalog: Catalog, history: Entry[]) {
  const directory = path.join(store, catalog.buildId);
  const reusable = new Map<string, string>();
  const sourceRoot = await realpath(source);
  for (const entry of history) {
    const retained = await readCatalog(path.join(store, entry.buildId));
    for (const [name, digest] of Object.entries(catalog.files)) {
      if (!reusable.has(name) && retained.files[name] === digest) reusable.set(name, path.join(store, entry.buildId, name));
      if (name.startsWith('assets/') && !/\.(br|gz)$/.test(name) && retained.files[name] && retained.files[name] !== digest) {
        throw new Error('Immutable frontend URL collision: ' + name);
      }
    }
  }
  const stage = await mkdtemp(path.join(store, '.stage-'));
  try {
    for (const [name, digest] of Object.entries(catalog.files)) {
      const input = path.join(source, name), target = path.join(stage, name);
      if (await realpath(input) !== path.join(sourceRoot, name) || !(await lstat(input)).isFile()) throw new Error('Invalid frontend asset: ' + name);
      await mkdir(path.dirname(target), { recursive: true });
      const retained = reusable.get(name);
      if (retained) {
        // The previous release was verified and is immutable; never link to the mutable build directory.
        if (hash(await readFile(input)) !== digest) throw new Error('Incomplete frontend build: ' + name);
        await link(retained, target).catch(async error => {
          if (!['ENOTSUP', 'EPERM', 'EOPNOTSUPP', 'EMLINK'].includes(error.code)) throw error;
          await copyFile(input, target);
        });
      } else await copyFile(input, target);
      if (hash(await readFile(target)) !== digest) throw new Error('Incomplete frontend build: ' + name);
    }
    await validateCatalog(stage, catalog);
    await writeFile(path.join(stage, catalogName), JSON.stringify(catalog) + '\n');
    const existing = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!existing) await rename(stage, directory);
    else {
      const installed = await readCatalog(directory);
      if (installed.buildId !== catalog.buildId || !sameFiles(installed.files, catalog.files)) throw new Error('Frontend build ID collision: ' + catalog.buildId);
      await verifyFrontendBuild(directory);
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Atomic current pointer; keep the newest three plus releases retired less than seven days ago. */
export async function publishFrontend(source: string, store: string, mode: 'activate' | 'bundle' | 'retain' = 'activate') {
  const catalog = await candidateCatalog(source);
  await mkdir(store, { recursive: true });
  const lock = path.join(store, '.publishing');
  await mkdir(lock).catch(error => {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Frontend publication already in progress: ' + lock), { code: error.code });
    throw error;
  });
  try {
    const index = await readIndex(store);
    const bundled = mode === 'bundle';
    if (mode === 'retain' && !index.releases.length) throw new Error('Publish the active frontend before retaining a historical build');
    if (bundled && index.bundled === catalog.buildId) return catalog.buildId;
    await installSnapshot(source, store, catalog, index.releases);
    const now = Date.now();
    const entry: Entry = { buildId: catalog.buildId, publishedAt: now };
    // Restarting a bundle already in the store must preserve an explicit hot publication or rollback.
    const known = index.releases.some(r => r.buildId === catalog.buildId);
    const keepCurrent = mode === 'retain' || bundled && index.releases.length && index.releases[0].buildId !== catalog.buildId && (!index.bundled || known);
    let ordered: Entry[];
    if (keepCurrent) ordered = known ? index.releases : [...index.releases, entry];
    else {
      const previous = index.releases.filter(r => r.buildId !== catalog.buildId)
        .map(r => r.buildId === index.releases[0]?.buildId ? { ...r, retiredAt: now } : r);
      ordered = [entry, ...previous];
    }
    const bundledId = bundled ? catalog.buildId : index.bundled;
    const releases = ordered.filter((r, i) => i < 3 || r.buildId === bundledId || now - (r.retiredAt ?? r.publishedAt) < 7 * 86400000);
    const temporary = path.join(store, '.current-' + randomUUID());
    await writeFile(temporary, JSON.stringify({ releases, bundled: bundledId }) + '\n');
    await rename(temporary, path.join(store, 'current.json'));
    for (const entry of ordered.filter(r => !releases.includes(r))) {
      await rm(path.join(store, entry.buildId), { recursive: true, force: true }).catch(error =>
        console.warn('Published frontend; could not remove retired directory:', entry.buildId, error.message));
    }
    return catalog.buildId;
  } finally { await rm(lock, { recursive: true }); }
}

export async function prepareBundledFrontend(source: string, store: string) {
  const index = await readIndex(store);
  const previous = index.bundled ?? index.releases[0]?.buildId;
  const info = await lstat(path.join(source, 'build-info.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) {
    if (!previous && await lstat(path.join(source, catalogName)).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      throw new Error('Incomplete frontend build: missing build-info.json');
    }
    return previous;
  }
  try {
    if (previous && index.bundled) {
      const candidate = await candidateCatalog(source);
      if (candidate.buildId === index.bundled) return index.bundled;
    }
    return await publishFrontend(source, store, 'bundle');
  } catch (error) {
    if (!previous) throw error;
    console.warn('Keeping the previously published frontend after bundle preparation failed:', error);
    return previous;
  }
}

type ReleaseView = { root: string; catalog: Catalog; assets: StaticAssets };

export class FrontendReleases {
  private views = new Map<string, Promise<ReleaseView>>();
  private store: Promise<string>;
  constructor(store: string) { this.store = realpath(store); }

  async currentBuildId() { return (await readIndex(await this.store)).releases[0]?.buildId; }

  async resolve(name: string, version: string | null) {
    const store = await this.store;
    const { releases } = await readIndex(store);
    // Page queries (including ?v=...) must not change navigation. Only content-addressed requests consult history.
    const digest = name.startsWith('vendor/') || /^icon-(192|512|maskable-512)\.png$/.test(name) ? version : null;
    const immutable = name.startsWith('assets/') || !!digest;
    const retained = new Set(releases.map(entry => entry.buildId));
    for (const id of this.views.keys()) if (!retained.has(id)) this.views.delete(id);
    for (const { buildId } of immutable ? releases : releases.slice(0, 1)) {
      let pending = this.views.get(buildId);
      if (!pending) {
        const root = path.join(store, buildId);
        pending = readCatalog(root).then(catalog => ({ root, catalog, assets: new StaticAssets(root) }));
        this.views.set(buildId, pending);
      }
      const view = await pending.catch(error => {
        this.views.delete(buildId);
        if (error.code !== 'ENOENT') throw error;
      });
      if (view && Object.hasOwn(view.catalog.files, name) && (!digest || view.catalog.files[name] === digest)) return view;
    }
  }
}
