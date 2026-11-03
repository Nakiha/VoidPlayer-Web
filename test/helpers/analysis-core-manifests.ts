import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Keep the server's selected build identity without providing a decoder. */
export async function copyAnalysisCoreManifests(source: string, destination: string) {
  await copyFile(join(source, 'manifest.json'), join(destination, 'manifest.json'));
  await copyFile(join(source, 'threading.json'), join(destination, 'threading.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
