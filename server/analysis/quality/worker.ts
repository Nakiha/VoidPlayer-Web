import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openIndexDatabase } from '../../sqlite.ts';
import { FrameIndexStore } from '../../frame-index-store.ts';
import { libraryPairSource } from './file-source.ts';
import { instantiateCore } from '../../../shared/wasm/core.ts';
import { createPairDecoder } from '../../../shared/analysis/quality/wasm-decoder.ts';
import { measureFlvFramePair, pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import { PsnrError } from '../../../shared/analysis/quality/psnr.ts';
import { AdminError } from '../../admin-error.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';

const {database,coreDir,request,paths}=workerData as {database:string;coreDir:string;request:FramePairRequest;paths:[string,string]};
const db=openIndexDatabase(database,{readOnly:true});db.exec('PRAGMA busy_timeout=1000;');
const store=new FrameIndexStore(db), opened:ReturnType<typeof libraryPairSource>[]=[];
try {
  const budget=pairBudget(request);
  for(const [i,target] of [request.reference,request.distorted].entries())opened.push(libraryPairSource(db,store,target,paths[i],budget));
  const result=await measureFlvFramePair(request,[opened[0].source,opened[1].source],budget=>createPairDecoder(async()=>{
    const binary=new Uint8Array(await readFile(path.join(coreDir,'voidplayer-core.wasm')));
    const glue=await import(pathToFileURL(path.join(coreDir,'voidplayer-core.js')).href);
    return instantiateCore(glue.default,binary,budget.maxHeapBytes);
  }),new AbortController().signal);
  const value:LibraryPairResult={schema:'voidplayer-library-frame-pair-psnr',version:1,
    execution:{host:'node-worker',runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun??process.versions.node,sourceIdentity:'stat-version-v1'},
    result,sources:{reference:opened[0].proof,distorted:opened[1].proof}};
  parentPort!.postMessage({ok:true,value});
} catch(error) {
  const e=error as Error&{code?:string;status?:number};
  const known=error instanceof FramePairError||error instanceof PsnrError||error instanceof AdminError;
  if(!known)console.error('Quality Worker failed',error);
  parentPort!.postMessage({ok:false,error:known?{message:e.message,code:e.code,status:e.status??(e.code==='budget-exceeded'?413:['source-changed','identity-mismatch','cache-miss'].includes(e.code??'')?409:e.code==='unsupported-source'?422:400)}:
    {message:e.code==='ENOENT'?'Pinned decoder assets are unavailable.':'Quality decoder failed.',code:e.code==='ENOENT'?'decoder-unavailable':'decoder-error',status:e.code==='ENOENT'?503:500}});
} finally { for(const {source} of opened)source.close();db.close();parentPort!.close(); }
