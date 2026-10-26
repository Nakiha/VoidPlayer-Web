import { openSync,closeSync,readSync,fstatSync,statSync,statfsSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { fileVersion } from '../../library.ts';
import { fileStatWitness,sameFileStat } from '../../file-stat.ts';
import type { FileStatWitness } from '../../file-stat.ts';
import type { IndexDatabase } from '../../sqlite.ts';
import {qualitySourceIndex} from '../../../shared/analysis/quality/source-index.ts';
import {createHash} from 'node:crypto';
import { FrameIndexStore } from '../../frame-index-store.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import type {QualityIndexDocument} from '../../../shared/analysis/quality/source-index.ts';
import type { PairTarget,CachedPairSource,PairBudget } from '../../../shared/analysis/quality/frame-pair.ts';

function changed(mediaId:string,field:string,detail?:Record<string,unknown>):never{
  console.error(JSON.stringify({event:'quality-source-rejected',mediaId,field,...(detail?{detail}:{})}));
  throw new FramePairError('source-changed',`Library source or cache binding changed (${field})`,field);
}
/** Same synchronous canonicalization for lookup and every subsequent check.
 * This runs only in the owned Worker, including statfs and database reads. */
export function resolvePairPath(db:IndexDatabase,id:string,version:string,size:number,witness?:FileStatWitness):string{
  try{
    const row=db.prepare("SELECT m.path,m.size,m.version,r.id AS rootId,r.path AS root FROM media m JOIN roots r ON r.id=m.root_id WHERE m.id=? AND m.state='ready' AND r.active=1").get(id);
    if(!row||row.version!==version||Number(row.size)!==size)return changed(id,'library-row');
    const prior=db.prepare('SELECT path,platform,fs_type FROM root_storage WHERE root_id=?').get(row.rootId!);
    const storage=statfsSync(String(row.root));
    if(!prior?.fs_type||prior.path!==row.root||prior.platform!==process.platform||prior.fs_type!==String(storage.type))
      return changed(id,'storage-binding',{expectedPlatform:prior?.platform,expectedType:prior?.fs_type,actualPlatform:process.platform,actualType:String(storage.type)});
    const root=realpathSync(String(row.root)),current=realpathSync(path.join(root,String(row.path))),prefix=root.endsWith(path.sep)?root:root+path.sep;
    if(!current.startsWith(prefix))return changed(id,'root-boundary');
    const stat=statSync(current);
    if(!stat.isFile()||fileVersion(stat)!==version||stat.size!==size)return changed(id,'path-version',{actualVersion:fileVersion(stat),expectedVersion:version});
    const actual=fileStatWitness(statSync(current,{bigint:true}));
    if(witness&&!sameFileStat(witness,actual))return changed(id,'path-stat',{expected:witness,actual});
    return current;
  }catch(error){if(error instanceof FramePairError)throw error;return changed(id,'identity-check-io',{code:(error as NodeJS.ErrnoException)?.code});}
}
/** Exact reads from a pinned descriptor, never a playback reader. */
export function libraryPairSource(db:IndexDatabase,store:FrameIndexStore,target:PairTarget,budget:PairBudget,control:Int32Array){
  const snapshot=store.qualitySource(target.mediaId,target.mediaVersion,true,budget,target.indexIdentity);
  if(snapshot.binding.indexBuildId!==target.indexBuildId||snapshot.binding.size!==target.size)throw new FramePairError('identity-mismatch','Quality cache binding changed');
  const filePath=resolvePairPath(db,target.mediaId,target.mediaVersion,target.size,snapshot.producer.sourceStat);
  let closed=false;
  const cancelled=()=>{if(Atomics.load(control,0)!==0)throw new Error('Quality source IO cancelled');};
  const binding=()=>{
    cancelled();if(closed)throw new FramePairError('source-changed','Quality file source is closed');
    const current=resolvePairPath(db,target.mediaId,target.mediaVersion,target.size,snapshot.producer.sourceStat);
    if(current!==filePath)return changed(target.mediaId,'resolved-path');
    const currentCache=store.qualitySource(target.mediaId,target.mediaVersion,false,undefined,target.indexIdentity);
    if(currentCache.binding.indexBuildId!==snapshot.binding.indexBuildId)return changed(target.mediaId,'cache-binding');
    return currentCache.binding;
  };
  const descriptor=(fd:number)=>{
    const opened=fstatSync(fd);
    if(!opened.isFile()||fileVersion(opened)!==target.mediaVersion||opened.size!==target.size)return changed(target.mediaId,'descriptor-version',{actualVersion:fileVersion(opened),expectedVersion:target.mediaVersion});
    const actual=fileStatWitness(fstatSync(fd,{bigint:true}));
    if(!sameFileStat(snapshot.producer.sourceStat,actual))return changed(target.mediaId,'descriptor-stat',{expected:snapshot.producer.sourceStat,actual});
  };
  const source:CachedPairSource<QualityIndexDocument>={digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),index:snapshot.index,binding,close(){closed=true;},
    async read(offset,length){
      binding();if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>target.size)throw new FramePairError('identity-mismatch','Quality read outside pinned source');
      const bytes=new Uint8Array(length);cancelled();
      // Double-check after registering IO so host cancellation cannot terminate
      // Bun between opening and closing an unmanaged descriptor. No await here.
      Atomics.add(control,1,1);
      try{
        cancelled();const fd=openSync(filePath,'r');
        try{
          descriptor(fd);let filled=0;
          while(filled<length){cancelled();const count=readSync(fd,bytes,filled,length-filled,offset+filled);if(!count)throw new FramePairError('source-changed','Short quality source read');filled+=count;}
          descriptor(fd);
        }finally{closeSync(fd);}
      }finally{Atomics.sub(control,1,1);Atomics.notify(control,1);}
      binding();return bytes;
    }};
  binding();
  const index=qualitySourceIndex(snapshot.index!,target.size),row=db.prepare('SELECT path,modified FROM media WHERE id=? AND version=?').get(target.mediaId,target.mediaVersion)!;
  if(index.codec!=='h264'&&index.codec!=='hevc')throw new FramePairError('unsupported-source','Unsupported candidate codec');
  const annotationContext={codec:index.codec,basis:(index.mp4?'complete-mp4-index-derived-v1':'complete-flv-index-derived-v1') as import('../../../shared/analysis/quality/library-pair.ts').QualityAnnotationContext['basis'],name:path.basename(String(row.path)),lastModified:Number(row.modified),
    firstPtsUs:index.firstPts,indexedDurationUs:index.duration,frameDurationUs:index.durations[index.order.indexOf(target.picture.au)]};
  return {source,proof:{binding:snapshot.binding,producer:snapshot.producer},annotationContext};
}
