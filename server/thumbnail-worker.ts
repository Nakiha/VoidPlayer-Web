import { parentPort, workerData } from 'node:worker_threads';
import { decodeCover } from './thumbnail-decode.ts';
import type { CoverInput } from './thumbnail-decode.ts';
import { loadServerPlaybackCore } from './playback-core.ts';

let runtime:ReturnType<typeof loadServerPlaybackCore>|undefined;
parentPort!.on('message',async (input:CoverInput) => {
  try {
    runtime??=loadServerPlaybackCore(workerData.coreDir,256*1024*1024);
    const image=await decodeCover(await runtime,input);
    parentPort!.postMessage({image});
  } catch (error) {parentPort!.postMessage({error:(error as Error).message});}
});
