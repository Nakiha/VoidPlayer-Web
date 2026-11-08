import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { playbackFiles, analysisFiles } from './core-artifacts.mjs';

const root = path.resolve(import.meta.dirname, '..');
for (const [folder, files] of [['voidplayer-core', playbackFiles], ['voidplayer-analysis', analysisFiles]]) {
  for (const file of files) await access(path.join(root, 'public/vendor', folder, file));
}
const output = path.join(root, 'artifacts/sites');
await mkdir(path.dirname(output), { recursive: true });
const stage = await mkdtemp(path.join(root, 'artifacts/.sites-'));
try {
  await build({ root, mode: 'sites', build: { outDir: path.join(stage, 'dist') } });
  await mkdir(path.join(stage, '.openai'));
  // Registration supplies the real project_id later; never copy the full app's Site identity.
  await writeFile(path.join(stage, '.openai/hosting.json'), JSON.stringify({ static: { directory: 'dist' } }, null, 2) + '\n');
  await cp(path.join(root, 'deploy/sites.md'), path.join(stage, 'README.md'));
  const identity = JSON.parse(await readFile(path.join(stage, 'dist/build-info.json'), 'utf8'));
  await writeFile(path.join(stage, 'sites-build.json'), JSON.stringify({ profile: 'sites', buildId: identity.buildId, revision: identity.revision, sourceDigest: identity.sourceDigest }, null, 2) + '\n');
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  console.log('Sites static project: ' + output);
} finally { await rm(stage, { recursive: true, force: true }); }
