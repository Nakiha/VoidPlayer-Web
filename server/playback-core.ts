import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instantiateCore } from '../shared/wasm/core.ts';

export async function loadServerPlaybackCore(directory:string, maxMemoryBytes?:number) {
  const glue = await import(pathToFileURL(path.join(directory,'voidplayer-core.js')).href);
  return instantiateCore(glue.default, await readFile(path.join(directory,'voidplayer-core.wasm')), maxMemoryBytes);
}
