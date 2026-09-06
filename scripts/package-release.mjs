import { cp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--target')) throw new Error('用法: node scripts/package-release.mjs [--target bun-linux-x64]');
const target = argv[1] ?? `bun-${process.platform}-${process.arch}`;
const targets = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64', 'bun-windows-x64', 'bun-windows-arm64'];
if (!targets.includes(target)) throw new Error(`暂不支持的目标: ${target}`);
const bun = process.env.BUN_BIN || 'bun';
const bunVersion = (await readFile(path.join(root, '.bun-version'), 'utf8')).trim();
if (execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim() !== bunVersion) throw new Error(`构建需要 Bun ${bunVersion}，用 BUN_BIN 指定该版本。`);
const required = ['index.html', 'licenses/voidplayer-web.txt', 'licenses/mediabunny.txt', 'licenses/phosphor-icons.txt', 'vendor/voidplayer-core/voidplayer-core.js', 'vendor/voidplayer-core/voidplayer-core.wasm', 'vendor/voidplayer-core/voidplayer-core-mt.js', 'vendor/voidplayer-core/voidplayer-core-mt.wasm', 'vendor/voidplayer-core/LICENSES/COPYING.LGPLv2.1', 'vendor/voidplayer-core/LICENSES/dav1d-COPYING'];
for (const name of required) if (!(await stat(path.join(root, 'dist', name)).catch(() => null))?.isFile()) throw new Error(`发布包缺少 ${name}；请先同步解码器并构建。`);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
const version = `${pkg.version}-preview.${revision.slice(0, 8)}${dirty ? '.dirty' : ''}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `voidplayer-${version}-${target.slice(4)}-${stamp}`;
const out = path.join(root, 'artifacts', name);
await mkdir(out, { recursive: true });
const executable = target.includes('windows') ? 'voidplayer.exe' : 'voidplayer';
execFileSync(bun, ['build', 'server/standalone.ts', '--compile', `--target=${target}`, '--minify', '--sourcemap', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--define', 'VOIDPLAYER_COMPILED=true', '--define', `VOIDPLAYER_VERSION=${JSON.stringify(version)}`, '--define', `VOIDPLAYER_REVISION=${JSON.stringify(revision + (dirty ? '-dirty' : ''))}`, '--outfile', path.join(out, executable)], { cwd: root, stdio: 'inherit' });
await cp(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
await cp(path.join(root, 'deploy/standalone.md'), path.join(out, 'README.md'));
await mkdir(path.join(out, 'deploy/licenses'), { recursive: true });
for (const file of ['Dockerfile', 'container.config.json', 'compose.yaml', 'Caddyfile', '.env.example', 'users.caddy.example', 'README.md', 'standalone.md']) await cp(path.join(root, 'deploy', file), path.join(out, 'deploy', file));
await cp(path.join(root, `deploy/licenses/Bun-${bunVersion}.md`), path.join(out, `deploy/licenses/Bun-${bunVersion}.md`));
await writeFile(path.join(out, 'voidplayer.config.example.json'), JSON.stringify({ mediaRoots: ['/absolute/path/to/media'], host: '127.0.0.1', port: 5180, allowLocalReveal: false, indexTtlMs: 30000 }, null, 2) + '\n');
// Include the exact application sources needed to rebuild with a different runtime.
// Explicit paths and Git's excludes keep media, local settings, credentials and logs out.
const rootFiles = new Set(['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', '.bun-version', '.gitignore', 'LICENSE', 'README.md', 'AGENTS.md', 'voidplayer.config.example.json']);
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceFiles = [...new Set(files)].filter(f => rootFiles.has(f) || /^(src|server|scripts|test|docs|public\/licenses|\.github)\//.test(f) || /^deploy\/(Dockerfile|container\.config\.json|compose\.yaml|Caddyfile|\.env\.example|users\.caddy\.example|README\.md|standalone\.md|licenses\/[^/]+)$/.test(f));
const sourceDir = path.join(out, '.source');
for (const file of sourceFiles) { await mkdir(path.dirname(path.join(sourceDir, file)), { recursive: true }); await cp(path.join(root, file), path.join(sourceDir, file)); }
execFileSync('tar', ['-czf', path.join(out, 'source.tar.gz'), '-C', sourceDir, '.']);
await rm(sourceDir, { recursive: true });
await writeFile(path.join(out, 'BUILD-SOURCES.md'), `# Build sources\n\nApplication: https://github.com/Nakiha/VoidPlayer-Web\nRevision: ${revision}${dirty ? ' (working changes included in source.tar.gz)' : ''}\nExact application snapshot: source.tar.gz\nBun: https://github.com/oven-sh/bun/tree/bun-v${bunVersion}\nBun notices: deploy/licenses/Bun-${bunVersion}.md\nWASM build source: https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/tree/wasm\nWASM licenses: dist/vendor/voidplayer-core/LICENSES\n\nWASM bytes are identified by release.json hashes. Their exact build revision is not yet recorded by the upstream artifact; verifying and recording it remains a formal-release gate.\n`);
const manifest = { schema: 'voidplayer-release', version: 2, appVersion: version, revision, dirty, target, runtime: { name: 'bun', version: bunVersion }, executable, createdAt: new Date().toISOString(), files: {} };
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
await writeFile(path.join(root, 'artifacts/latest-release.json'), JSON.stringify({ directory: out, archive: `${out}.tar.gz`, target }, null, 2) + '\n');
console.log(`发布包: ${out}.tar.gz\n校验文件: ${out}.tar.gz.sha256`);
