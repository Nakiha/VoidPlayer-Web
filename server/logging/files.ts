import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Only ordinary owned files participate in accounting, never symlinks. */
export async function* logFiles(directory: string, matches: (name: string) => boolean) {
  const handle = await fs.opendir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return;
  for await (const entry of handle) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isFile() && !stat.isSymbolicLink()) yield { name: entry.name, file, stat };
  }
}
