import { openSync, closeSync, readSync, fstatSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileVersion } from '../../library.ts';
import { fileStatWitness, sameFileStat } from '../../file-stat.ts';
import type { IndexDatabase } from '../../sqlite.ts';
import { FrameIndexStore } from '../../frame-index-store.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import type { PairTarget, CachedPairSource, PairBudget } from '../../../shared/analysis/quality/frame-pair.ts';

/** Exact positional reads from a pinned descriptor, never a playback reader.
 * The library's existing stat-derived identity is deliberately not a content hash. */
export function libraryPairSource(db: IndexDatabase, store: FrameIndexStore, target: PairTarget, filePath: string, budget: PairBudget) {
  const snapshot = store.qualitySource(target.mediaId,target.mediaVersion,true,budget);
  const changed = (field:string, detail?:Record<string,unknown>): never => {
    // Local diagnostics distinguish platform IO/identity failures without
    // exposing filesystem paths or pixel data through the HTTP response.
    console.error(JSON.stringify({event:'quality-source-rejected',mediaId:target.mediaId,field,...(detail?{detail}:{})}));
    throw new FramePairError('source-changed',`Library source or cache binding changed (${field})`,field);
  };
  let fd: number | undefined;
  const binding = () => {
    try {
      const row = db.prepare("SELECT m.path,m.size,m.version,r.path AS root FROM media m JOIN roots r ON r.id=m.root_id WHERE m.id=? AND m.state='ready' AND r.active=1").get(target.mediaId);
      if (!row || row.version!==target.mediaVersion || Number(row.size)!==target.size) return changed('library-row');
      const root = realpathSync(String(row.root)), current = realpathSync(path.join(root,String(row.path)));
      if (!current.startsWith(root+path.sep)) return changed('root-boundary');
      if (current!==filePath) return changed('resolved-path',{sameIgnoringCase:current.toLowerCase()===filePath.toLowerCase(),currentNamespaced:current.startsWith('\\\\?\\'),expectedNamespaced:filePath.startsWith('\\\\?\\')});
      const stat = statSync(current);
      if (!stat.isFile() || fileVersion(stat)!==target.mediaVersion || stat.size!==target.size) return changed('path-version',{actualVersion:fileVersion(stat),expectedVersion:target.mediaVersion});
      const pathStat=fileStatWitness(statSync(current,{bigint:true}));
      if(!sameFileStat(snapshot.producer.sourceStat,pathStat))return changed('path-stat',{expected:snapshot.producer.sourceStat,actual:pathStat});
      if (fd!==undefined) { const opened=fstatSync(fd); if(!opened.isFile() || fileVersion(opened)!==target.mediaVersion || opened.size!==target.size) return changed('descriptor-version',{actualVersion:fileVersion(opened),expectedVersion:target.mediaVersion}); }
      if(fd!==undefined){const openedStat=fileStatWitness(fstatSync(fd,{bigint:true}));if(!sameFileStat(snapshot.producer.sourceStat,openedStat))return changed('descriptor-stat',{expected:snapshot.producer.sourceStat,actual:openedStat});}
      const currentCache = store.qualitySource(target.mediaId,target.mediaVersion);
      if (currentCache.binding.indexBuildId!==snapshot.binding.indexBuildId) return changed('cache-binding');
      return currentCache.binding;
    } catch(error) { if(error instanceof FramePairError)throw error; return changed('identity-check-io',{code:(error as NodeJS.ErrnoException)?.code}); }
  };
  const close = () => { if (fd!==undefined) { const opened=fd;fd=undefined;closeSync(opened); } };
  try {
    binding(); fd=openSync(filePath,'r'); binding();
    const source: CachedPairSource = {
      index:snapshot.index,binding,close,
      async read(offset,length) {
        binding();
        if(fd===undefined)throw new FramePairError('source-changed','Quality file descriptor is closed');
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>target.size)
          throw new FramePairError('identity-mismatch','Quality read outside pinned source');
        const bytes=new Uint8Array(length);let filled=0;
        while(filled<length){const count=readSync(fd,bytes,filled,length-filled,offset+filled);if(!count)throw new FramePairError('source-changed','Short quality source read');filled+=count;}
        binding();return bytes;
      },
    };
    return {source,proof:{binding:snapshot.binding,producer:snapshot.producer}};
  } catch(error) { close();throw error; }
}
