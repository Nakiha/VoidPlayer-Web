import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { openIndexDatabase } from '../sqlite.ts';
import { resolvePairPath } from '../analysis/quality/file-source.ts';
import { fileStatWitness, sameFileStat } from '../file-stat.ts';
import { probeMedia } from '../../shared/media/probe.ts';
import { DISCOVERY_LIMITS } from '../../shared/media/discovery.ts';
import type { ProbeValue,ProbeWorkerData } from './probe-runner.ts';

/** Optional stage observer is internal test instrumentation, never sourced from
 * an HTTP request or production workerData. */
export async function runProbeTask({database,source,control}:ProbeWorkerData,before?:(phase:'opened'|'publish'|'parse',fd:number)=>Promise<void>):Promise<ProbeValue>{
  const gate=new Int32Array(control),check=()=>{if(Atomics.load(gate,0))throw Error('cancelled');};
    const withDatabase=<T>(work:(db:ReturnType<typeof openIndexDatabase>)=>T):T=>{
      check();Atomics.add(gate,1,1);let db:ReturnType<typeof openIndexDatabase>|undefined,closed=false;
      try{check();db=openIndexDatabase(database,{readOnly:true});db.exec('PRAGMA busy_timeout=1000;');check();return work(db);}
      finally{try{db?.close();closed=true;}finally{if(closed){Atomics.sub(gate,1,1);Atomics.notify(gate,1);}}}
    };
    const {size,file,witness}=withDatabase(db=>{
      const media=db.prepare("SELECT size FROM media WHERE id=? AND version=? AND state='ready'").get(source.id,source.version);
      if(!media)throw Error('source-changed');const size=Number(media.size),file=resolvePairPath(db,source.id,source.version,size);
      const witness=fileStatWitness(statSync(file,{bigint:true}));resolvePairPath(db,source.id,source.version,size,witness);check();return {size,file,witness};
    });
    // Parser CPU work owns no open file. Every asynchronous open/read/stat/close
    // is fenced, double-checking revocation before starting any OS operation.
    const withFile=async<T>(work:(handle:FileHandle)=>Promise<T>):Promise<T>=>{
      check();Atomics.add(gate,1,1);let handle:FileHandle|undefined,closed=false;
      try{check();handle=await open(file,'r');check();
        if(!sameFileStat(witness,fileStatWitness(await handle.stat({bigint:true}))))throw Error('source-changed');check();
        const value=await work(handle);check();
        if(!sameFileStat(witness,fileStatWitness(await handle.stat({bigint:true}))))throw Error('source-changed');check();return value;
      }finally{
        try{if(handle)await handle.close();closed=true;}
        finally{if(closed){Atomics.sub(gate,1,1);Atomics.notify(gate,1);}}
      }
    };
    await withFile(async handle=>{await before?.('opened',handle.fd);check();});
    await before?.('parse',-1);check();
    let physicalReads=0;
    const result=await probeMedia(source,size,async(offset,length)=>withFile(async handle=>{
      check();const bytes=new Uint8Array(length);let at=0;
      while(at<length){check();if(++physicalReads>DISCOVERY_LIMITS.probeReadCalls)throw Error('probe-read-call-budget-exceeded');const got=await handle.read(bytes,at,length-at,offset+at);check();if(!got.bytesRead)throw Error('source-changed');at+=got.bytesRead;}
      return bytes;
    }),check);
    result.coverage.readCalls=physicalReads;
    await withFile(async handle=>{await before?.('publish',handle.fd);check();});
    withDatabase(db=>{if(resolvePairPath(db,source.id,source.version,size,witness)!==file)throw Error('source-changed');check();});
    if(Buffer.byteLength(JSON.stringify(result))>DISCOVERY_LIMITS.probeResultBytes)throw Error('probe-result-budget-exceeded');
    return {probe:result,witness};
}
