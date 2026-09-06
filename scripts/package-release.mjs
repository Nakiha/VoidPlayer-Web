import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = ['index.html', 'vendor/voidplayer-core/voidplayer-core.js', 'vendor/voidplayer-core/voidplayer-core.wasm', 'vendor/voidplayer-core/voidplayer-core-mt.js', 'vendor/voidplayer-core/voidplayer-core-mt.wasm', 'vendor/voidplayer-core/LICENSES'];
for (const name of required) if (!(await stat(path.join(root, 'dist', name)).catch(() => null))) throw new Error(`发布包缺少 ${name}；请先同步解码器并构建。`);
const name = `voidplayer-web-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const out = path.join(root, 'artifacts', name); await mkdir(out, { recursive: true });
// Explicit allowlist: no media fixtures, logs, credentials or local config.
for (const folder of ['dist', 'server']) await cp(path.join(root, folder), path.join(out, folder), { recursive: true });
await cp(path.join(root, 'voidplayer.config.example.json'), path.join(out, 'voidplayer.config.example.json'));
const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(out, 'package.json'), JSON.stringify({ name: sourcePackage.name, version: sourcePackage.version, private: true, type: 'module', engines: sourcePackage.engines, scripts: { start: 'node server/main.ts' } }, null, 2) + '\n');
await mkdir(path.join(out, 'deploy'));
for (const file of ['Dockerfile', 'container.config.json', 'compose.yaml', 'Caddyfile', '.env.example', 'users.caddy.example', 'README.md']) await cp(path.join(root, 'deploy', file), path.join(out, 'deploy', file));
const manifest = { schema: 'voidplayer-release', version: 1, createdAt: new Date().toISOString(), node: '>=24', files: {} };
async function hashFolder(folder, prefix = '') {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) await hashFolder(file, `${relative}/`);
    else manifest.files[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
await hashFolder(out); await writeFile(path.join(out, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('tar', ['-czf', `${out}.tar.gz`, '-C', path.dirname(out), name]);
const checksum = createHash('sha256').update(await readFile(`${out}.tar.gz`)).digest('hex');
await writeFile(`${out}.tar.gz.sha256`, `${checksum}  ${name}.tar.gz\n`);
console.log(`发布包: ${out}.tar.gz\n校验文件: ${out}.tar.gz.sha256`);
