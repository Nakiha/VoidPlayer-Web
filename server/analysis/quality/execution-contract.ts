import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync} from 'node:fs';
import path from 'node:path';
import type {ExecutionEnvironment,QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import {sameExecutionContract,canonicalExecutionSources,REEXECUTION_LIMITS} from '../../../shared/analysis/quality/reexecution.ts';
import {FramePairError} from '../../../shared/analysis/quality/frame-pair.ts';
import type {PairTarget,PairBudget} from '../../../shared/analysis/quality/frame-pair.ts';
import {qualitySourceIndex,qualityIndexPacketCount} from '../../../shared/analysis/quality/source-index.ts';
import type {IndexDatabase} from '../../sqlite.ts';
import {FrameIndexStore} from '../../frame-index-store.ts';
import {libraryPairSource} from './file-source.ts';

/** Only call inside an owned Worker. Synchronous descriptors are registered in
 * its existing IO fence and always closed before physical termination. */
export function executionEnvironment(coreDir:string,control:Int32Array,check:()=>void):ExecutionEnvironment{
  let total=0;
  const assets=['voidplayer-core.js','voidplayer-core.wasm','capabilities.json','provenance.json'].map(file=>{
    check();Atomics.add(control,1,1);let fd:number|undefined;
    try{fd=openSync(path.join(coreDir,file),'r');const stat=fstatSync(fd);
      if(!stat.isFile()||stat.size<1||stat.size>32*1024*1024||total+stat.size>REEXECUTION_LIMITS.maxReadBytes)throw new FramePairError('budget-exceeded','Execution asset witness exceeds its metadata budget');
      const bytes=Buffer.alloc(Math.min(stat.size,64*1024)),hash=createHash('sha256');let offset=0;while(offset<stat.size){check();const n=readSync(fd,bytes,0,Math.min(bytes.length,stat.size-offset),offset);if(!n)throw new FramePairError('source-changed','Execution asset changed during witness read');hash.update(bytes.subarray(0,n));offset+=n;}
      const after=fstatSync(fd);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new FramePairError('source-changed','Execution asset changed during witness read');
      total+=stat.size;return {file,sha256:hash.digest('hex'),bytes:stat.size};
    }finally{if(fd!==undefined)closeSync(fd);Atomics.sub(control,1,1);Atomics.notify(control,1);}
  });
  return {schema:'voidplayer-quality-execution-environment',version:1,runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun??process.versions.node,recipe:'source-yuv-psnr-ssim-packet-identity-v1',assets};
}
export function executionSources(db:IndexDatabase,targets:PairTarget[],budget:PairBudget,control:Int32Array){
  const store=new FrameIndexStore(db),seen=new Map<string,{proof:ReturnType<typeof libraryPairSource>['proof'];index:ReturnType<typeof qualitySourceIndex>}>();let indexBytes=0,indexPackets=0;
  for(const t of targets){
    const key=JSON.stringify([t.mediaId,t.mediaVersion,t.indexIdentity,t.indexBuildId]);
    let cached=seen.get(key);
    if(!cached){const opened=libraryPairSource(db,store,t,{...budget,maxIndexBytes:Math.min(budget.maxIndexBytes,REEXECUTION_LIMITS.maxIndexBytes-indexBytes),maxIndexPackets:Math.min(budget.maxIndexPackets,REEXECUTION_LIMITS.maxIndexPackets-indexPackets)},control);
      try{const doc=opened.source.index!;indexBytes+=Buffer.byteLength(JSON.stringify(doc));indexPackets+=qualityIndexPacketCount(doc);if(indexBytes>REEXECUTION_LIMITS.maxIndexBytes||indexPackets>REEXECUTION_LIMITS.maxIndexPackets)throw new FramePairError('budget-exceeded','Reexecution metadata index budget exceeded');cached={proof:opened.proof,index:qualitySourceIndex(doc,t.size)};seen.set(key,cached);}finally{opened.source.close();}
    }
    // The trusted document digest/producer commit is checked by FrameIndexStore.
    // Verify every frozen target clock/configuration against that same document.
    const index=cached.index,packet=index.packets[t.picture.au];
    if(cached.proof.binding.indexBuildId!==t.indexBuildId||!packet||packet.pts!==t.sourcePtsUs||t.picture.configuration!==(packet.configuration??0)||t.picture.sourceVersion!==cached.proof.producer.sourceVersion||t.picture.picture!==0||t.picture.layer!==0||t.picture.field!=='frame')throw new FramePairError('identity-mismatch','Frozen AU/configuration/clock is unavailable');
  }
  return {sources:canonicalExecutionSources([...seen.values()].map(v=>v.proof)),indexBytes,indexPackets};
}
export function requireExecutionContract(expected:QualityExecutionContract|undefined,actual:QualityExecutionContract){
  if(expected&&!sameExecutionContract(expected,actual))throw new FramePairError('identity-mismatch','Frozen execution conditions changed; create a new intent instead of reexecution');
}
