import { open, stat } from 'node:fs/promises';
import { AdminError } from './admin-error.ts';
import { fileVersion, fileStatWitness, sameFileStat } from './file-stat.ts';
import { readProvider, verifyProvider, type ProviderSource } from './media-provider.ts';

export type MediaInput = string | ProviderSource;

/** A worker owns its handle. Each remote read carries the captured upstream revision. */
export async function openVersionedInput(input: MediaInput, size: number, version: string, precise = false, signal?: AbortSignal) {
  if (typeof input !== 'string') {
    return {
      witness:undefined,
      verify:() => verifyProvider(input,signal),
      read:async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(await readProvider(input,position,length,signal),offset);
        return {bytesRead:length};
      },
      close:async () => {},
    };
  }
  const handle = await open(input,'r');
  try {
    const witness = precise ? fileStatWitness(await handle.stat({bigint:true})) : undefined;
    return {
      witness,
      async verify() {
        const [opened,current] = await Promise.all([handle.stat(),stat(input)]);
        if (!opened.isFile() || !current.isFile() || opened.size !== size || current.size !== size
          || fileVersion(opened) !== version || fileVersion(current) !== version)
          throw new AdminError(409,'媒体文件在读取期间改变。');
        if (witness && (!sameFileStat(witness,fileStatWitness(await handle.stat({bigint:true})))
          || !sameFileStat(witness,fileStatWitness(await stat(input,{bigint:true})))))
          throw new AdminError(409,'媒体文件在读取期间改变。');
      },
      read:(buffer: Uint8Array, offset: number, length: number, position: number) => handle.read(buffer,offset,length,position),
      close:() => handle.close(),
    };
  } catch (error) { await handle.close(); throw error; }
}
