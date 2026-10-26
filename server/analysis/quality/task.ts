import {qualityIndexPacketCount} from '../../../shared/analysis/quality/source-index.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openIndexDatabase } from '../../sqlite.ts';
import { FrameIndexStore } from '../../frame-index-store.ts';
import { libraryPairSource,resolvePairPath } from './file-source.ts';
import { instantiateCore } from '../../../shared/wasm/core.ts';
import { createPairDecoder } from '../../../shared/analysis/quality/wasm-decoder.ts';
import { measureFramePair,pairBudget,FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import { qualityFrameCandidates } from '../../../shared/analysis/quality/selection.ts';
import type { QualityFramePage,QualityFrameQuery } from '../../../shared/analysis/quality/selection.ts';
import { PAIR_LIMITS } from '../../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairBinding,LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';
import {buildCorrespondence} from '../../../shared/analysis/quality/correspondence.ts';
import type {ReferenceRelation,CorrespondenceInput,CorrespondenceResult} from '../../../shared/analysis/quality/correspondence.ts';
import {QUALITY_SOURCE_BUILD_LIMITS} from '../../../shared/analysis/quality/source-build.ts';
import {FLV_MEDIA_INDEX_IDENTITY,MP4_QUALITY_MEDIA_INDEX_IDENTITY} from '../../../shared/media/indexing/media-index-identity.ts';
import {buildMp4QualityDocument,qualitySourceContainer} from '../../mp4-quality-builder.ts';
import type {QualityIndexDocument} from '../../../shared/analysis/quality/source-index.ts';
import {buildFlvIndexDocument} from '../../flv-index-builder.ts';
import {prepareFrameIndex} from '../../frame-index-store.ts';
export type QualityTask={mode:'correspondence-plan';relation:ReferenceRelation;request:CorrespondenceInput}|{mode:'source';id:string;version:string}|{mode:'build-source';id:string;version:string}|{mode:'frames';id:string;version:string;query:QualityFrameQuery}|{mode:'measure';request:FramePairRequest};
export type QualityPhase='source'|'resolve'|'decode'|'publish';
/** A narrow stage observer lets tests suspend the actual IO boundaries. It is
 * never read from the HTTP request or production workerData. */
export async function runQualityTask(data:QualityTask&{database:string;coreDir:string;control:SharedArrayBuffer},signal:AbortSignal,before?:(phase:QualityPhase)=>Promise<void>):Promise<LibraryPairBinding|LibraryPairResult|QualityFramePage|CorrespondenceResult>{
  const control=new Int32Array(data.control);
  const check=()=>{signal.throwIfAborted();if(Atomics.load(control,0)!==0)throw new FramePairError('source-changed','Quality execution cancelled');};
  const phase=async(name:QualityPhase)=>{check();await before?.(name);check();};
  const db=openIndexDatabase(data.database,{readOnly:data.mode!=='build-source'});db.exec('PRAGMA busy_timeout=1000;');
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
    if(data.mode==='build-source'){
      await phase('resolve');
      const media=db.prepare("SELECT size FROM media WHERE id=? AND version=? AND state='ready'").get(data.id,data.version);
      if(!media)throw new FramePairError('source-changed','Library source changed');
      const size=Number(media.size);
      if(!Number.isSafeInteger(size)||size<1||size>QUALITY_SOURCE_BUILD_LIMITS.maxSourceBytes)throw new FramePairError('budget-exceeded','Explicit FLV build source size budget exceeded');
      const filePath=resolvePairPath(db,data.id,data.version,size),epoch=store.epoch;
      // Probe and both parser paths share the same owned IO fence. No permit is
      // acquired here: the one-shot runner already owns the physical slot.
      Atomics.add(control,1,1);let result:{document:QualityIndexDocument;profile:{sourceStat:import('../../file-stat.ts').FileStatWitness;scannedBytes:number;diskReadBytes:number}};let kind:'flv'|'mp4';
      try{check();const detected=await qualitySourceContainer(filePath,check);kind=detected.kind;const identity=kind==='mp4'?MP4_QUALITY_MEDIA_INDEX_IDENTITY:FLV_MEDIA_INDEX_IDENTITY;
        if(store.has(data.id,data.version,kind,identity))return source(data.id,data.version);
        const limits={...QUALITY_SOURCE_BUILD_LIMITS,maxReadBytes:QUALITY_SOURCE_BUILD_LIMITS.maxReadBytes-detected.readBytes};
        result=kind==='mp4'?await buildMp4QualityDocument(filePath,size,data.version,limits,check,()=>phase('resolve')):await buildFlvIndexDocument(filePath,size,data.version,undefined,limits,check,()=>phase('resolve'));
        result.profile.diskReadBytes+=detected.readBytes;check();
      }
      catch(error){if(['ENOENT','ESTALE','ENOTDIR','EISDIR','EACCES'].includes((error as NodeJS.ErrnoException)?.code??''))throw new FramePairError('source-changed','Library source became unavailable during explicit build');throw error;}
      finally{Atomics.sub(control,1,1);Atomics.notify(control,1);}
      await phase('publish');
      if(result.profile.scannedBytes!==size||result.document.schema!=="voidplayer-mp4-quality-index"&&(result.document.truncatedAt!==undefined||result.document.recoveredGaps))
        throw new FramePairError('unsupported-source','Explicit quality build requires a complete unrecovered FLV');
      if(resolvePairPath(db,data.id,data.version,size,result.profile.sourceStat)!==filePath)throw new FramePairError('source-changed','Library source changed during explicit build');
      check();store.commit(data.id,data.version,prepareFrameIndex(result.document,size,kind==='mp4'?MP4_QUALITY_MEDIA_INDEX_IDENTITY:FLV_MEDIA_INDEX_IDENTITY,`${data.id}@${data.version}`,{scannedBytes:result.profile.scannedBytes}),epoch,{kind:kind==='mp4'?'server-mp4-scan-v1':'server-flv-scan-v1',sourceStat:result.profile.sourceStat});
      return source(data.id,data.version);
    }
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
    if(data.mode==='correspondence-plan'){
      const started=performance.now(),limits=data.request.planningBudget;
      let indexBytes=0,indexPackets=0;
      const snapshots=[] as (LibraryPairBinding&{index:NonNullable<ReturnType<FrameIndexStore['qualitySource']>['index']>})[];
      for(const [side,expected] of [data.relation.input.reference,data.relation.input.distorted].entries()){
        const prior=source(expected.mediaId,expected.mediaVersion),build=side?data.request.distortedBuildId:data.request.referenceBuildId;
        if(prior.binding.indexBuildId!==build)throw new FramePairError('identity-mismatch','Pinned correspondence cache changed');
        const snapshot=store.qualitySource(expected.mediaId,expected.mediaVersion,true,{...PAIR_LIMITS,maxIndexBytes:Math.min(PAIR_LIMITS.maxIndexBytes,limits.maxIndexBytes-indexBytes),maxIndexPackets:Math.min(PAIR_LIMITS.maxIndexPackets,limits.maxIndexPackets-indexPackets)});
        indexBytes+=Buffer.byteLength(JSON.stringify(snapshot.index));indexPackets+=qualityIndexPacketCount(snapshot.index!);
        if(indexBytes>limits.maxIndexBytes||indexPackets>limits.maxIndexPackets)throw new FramePairError('budget-exceeded','Total correspondence index read/packet budget exceeded');
        snapshots.push({...snapshot,index:snapshot.index!});check();
      }
      await phase('resolve');
      const value=buildCorrespondence(data.relation,data.request,snapshots as [typeof snapshots[number],typeof snapshots[number]],{indexBytes,indexPackets,sourceReadBytes:0,decodedFrames:0,elapsedMs:0});
      await phase('publish');for(const snapshot of snapshots){const current=source(snapshot.binding.mediaId,snapshot.binding.mediaVersion);if(current.binding.indexBuildId!==snapshot.binding.indexBuildId)throw new FramePairError('source-changed','Correspondence cache changed before publication');}
      value.work.elapsedMs=Math.ceil(performance.now()-started);return value;
    }
    const {request}=data,budget=pairBudget(request),targets=[request.reference,request.distorted];
    for(const target of targets){const snapshot=source(target.mediaId,target.mediaVersion);
      if(snapshot.binding.indexBuildId!==target.indexBuildId||snapshot.binding.size!==target.size)throw new FramePairError('identity-mismatch','Quality cache binding changed');}
    await phase('resolve');
    for(const target of targets)opened.push(libraryPairSource(db,store,target,budget,control));
    const result=await measureFramePair(request,[opened[0].source,opened[1].source],budget=>createPairDecoder(async()=>{
      await phase('decode');
      check();const binary=new Uint8Array(await readFile(path.join(data.coreDir,'voidplayer-core.wasm')));check();
      const glue=await import(pathToFileURL(path.join(data.coreDir,'voidplayer-core.js')).href);check();
      const loaded=await instantiateCore(glue.default,binary,budget.maxHeapBytes);check();return loaded;
    }),signal);
    await phase('publish');
    for(const target of targets){const current=source(target.mediaId,target.mediaVersion);if(current.binding.indexBuildId!==target.indexBuildId)throw new FramePairError('source-changed','Quality cache changed before publication');}
    check();
    return {schema:'voidplayer-library-frame-pair-psnr',version:targets.some(t=>t.indexIdentity.kind==='mp4')?2:1,
      execution:{host:'node-worker',runtime:process.versions.bun?'bun':'node',runtimeVersion:process.versions.bun??process.versions.node,sourceIdentity:'stat-version-v1'},
      result,annotationContext:{reference:opened[0].annotationContext,distorted:opened[1].annotationContext},sources:{reference:opened[0].proof,distorted:opened[1].proof}};
  }finally{for(const {source} of opened)source.close();db.close();}
}
