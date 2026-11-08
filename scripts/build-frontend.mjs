// dist is a portable build artifact. The running service serves its separate immutable publication store.
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const scratch = path.resolve('.run/frontend-build');
await mkdir(scratch, { recursive: true });
const lock = path.join(scratch, 'lock');
await mkdir(lock);
const target = path.resolve('dist'), previous = path.join(scratch, 'previous');
const exists = file => stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
try {
  if (await exists(previous)) {
    if (await exists(target)) await rm(previous, { recursive: true });
    else await rename(previous, target);
  }
  const stage = await mkdtemp(path.join(scratch, 'candidate-'));
  try {
    await build({ build: { outDir: stage } });
    const existed = await exists(target);
    if (existed) await rename(target, previous);
    try { await rename(stage, target); }
    catch (error) { if (existed) await rename(previous, target); throw error; }
    if (existed) await rm(previous, { recursive: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
} finally { await rm(lock, { recursive: true }); }
