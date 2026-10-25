import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openIndexDatabase } from '../../sqlite.ts';
import { FrameIndexStore } from '../../frame-index-store.ts';
import { libraryPairSource,resolvePairPath } from './file-source.ts';
import { instantiateCore } from '../../../shared/wasm/core.ts';
import { createPairDecoder } from '../../../shared/analysis/quality/wasm-decoder.ts';
import { measureFlvFramePair,pairBudget,FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import { qualityFrameCandidates } from '../../../shared/analysis/quality/selection.ts';
import type { QualityFramePage,QualityFrameQuery } from '../../../shared/analysis/quality/selection.ts';
import { PAIR_LIMITS } from '../../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairBinding,LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';
export type QualityTask={mode:'source';id:string;version:string}|{mode:'frames';id:string;version:string;query:QualityFrameQuery}|{mode:'measure';request:FramePairRequest};
export type QualityPhase='source'|'resolve'|'decode'|'publish';
/** A narrow stage observer lets tests suspend the actual IO boundaries. It is
 * never read from the HTTP request or production workerData. */
export async function runQualityTask(data:QualityTask&{database:string;coreDir:string;control:SharedArrayBuffer},signal:AbortSignal,before?:(phase:QualityPhase)=>Promise<void>):Promise<LibraryPairBinding|LibraryPairResult|QualityFramePage>{
  const control=new Int32Array(data.control);
  const check=()=>{signal.throwIfAborted();if(Atomics.load(control,0)!==0)throw new FramePairError('source-changed','Quality execution cancelled');};
  const phase=async(name:QualityPhase)=>{check();await before?.(name);check();};
  const db=openIndexDatabase(data.database,{readOnly:true});db.exec('PRAGMA busy_timeout=1000;');
  const store=new FrameIndexStore(db),opened:ReturnType<typeof libraryPairSource>[]=[];
  const source=(id:string,version:string)=>{
    check();
    const media=db.prepare("SELECT size FROM media WHERE id=? AND version=? AND state='ready'").get(id,version);
    if(!media)throw new FramePairError('source-changed','Library source changed');
    // Preserve source-version errors even when its old cache has also vanished.
    // This preliminary check never admits pixels without producer evidence.
    resolvePairPath(db,id,version,Number(media.size));
    const snapshot=store.qualitySource(id,version);
    resolvePairPath(db,id,version,snapshot.binding.size,snapshot.producer.sourceStat);
    const current=store.qualitySource(id,version);
    if(current.binding.indexBuildId!==snapshot.binding.indexBuildId)throw new FramePairError('source-changed','Quality cache changed during source checks');
    check();return {binding:snapshot.binding,producer:snapshot.producer};
  };
  try{
    await phase('source');
    if(data.mode==='source'||data.mode==='frames'){
      await phase('resolve');const value=source(data.id,data.version);
      let page:QualityFramePage|undefined;
      if(data.mode==='frames'){
        const snapshot=store.qualitySource(data.id,data.version,true,PAIR_LIMITS);
        if(snapshot.binding.indexBuildId!==value.binding.indexBuildId)throw new FramePairError('source-changed','Quality cache changed during selection');
        page=qualityFrameCandidates({binding:snapshot.binding,producer:snapshot.producer},snapshot.index!,data.query);
      }
      await phase('publish');const current=source(data.id,data.version);
      if(current.binding.indexBuildId!==value.binding.indexBuildId)throw new FramePairError('source-changed','Quality cache changed before publication');return page??value;
    }
    const {request}=data,budget=pairBudget(request),targets=[request.reference,request.distorted];
    for(const target of targets){const snapshot=source(target.mediaId,target.mediaVersion);
      if(snapshot.binding.indexBuildId!==target.indexBuildId||snapshot.binding.size!==target.size)throw new FramePairError('identity-mismatch','Quality cache binding changed');}
    await phase('resolve');
    for(const target of targets)opened.push(libraryPairSource(db,store,target,budget,control));
    const result=await measureFlvFramePair(request,[opened[0].source,opened[1].source],budget=>createPairDecoder(async()=>{
      await phase('decode');
      check();const binary=new Uint8Array(await readFile(path.join(data.coreDir,'voidplayer-core.wasm')));check();
      const glue=await import(pathToFileURL(path.join(data.coreDir,'voidplayer-core.js')).href);check();
      const loaded=await instantiateCore(glue.default,binary,budget.maxHeapBytes);check();return loaded;
    }),signal);
    await phase('publish');
    for(const target of targets){const current=source(target.mediaId,target.mediaVersion);if(current.binding.indexBuildId!==target.indexBuildId)throw new FramePairError('source-changed','Quality cache changed before publication');}
    check();
    return {schema:'voidplayer-library-frame-pair-psnr',version:1,
      execution:{host:'node-worker',runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun??process.versions.node,sourceIdentity:'stat-version-v1'},
      result,sources:{reference:opened[0].proof,distorted:opened[1].proof}};
  }finally{for(const {source} of opened)source.close();db.close();}
}
