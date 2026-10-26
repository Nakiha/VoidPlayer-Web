import {open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileVersion} from './library.ts';
import {fileStatWitness,sameFileStat} from './file-stat.ts';
import {AdminError} from './admin-error.ts';
import {readMp4QualityIndex} from '../shared/media/indexing/mp4-quality-index.ts';
import type {FlvIndexBuildLimits} from './flv-index-builder.ts';

export async function qualitySourceContainer(filePath:string,check=()=>{}){
  check();const handle=await open(filePath,'r');try{check();const bytes=new Uint8Array(16),r=await handle.read(bytes,0,16,0);check();if(r.bytesRead<8)throw new AdminError(422,'Unsupported quality source container.','unsupported-source');
    if(String.fromCharCode(...bytes.subarray(0,3))==='FLV')return {kind:'flv' as const,readBytes:r.bytesRead};
    if(['ftyp','free','wide','skip','mdat','moov'].includes(String.fromCharCode(...bytes.subarray(4,8))))return {kind:'mp4' as const,readBytes:r.bytesRead};
    throw new AdminError(422,'Quality preparation supports strict FLV or non-fragmented MP4 only.','unsupported-source');
  }finally{await handle.close();}
}

/** The caller registers owned IO before entering. Every exit closes the real
 * descriptor before the Worker can release admission or publish its result. */
export async function buildMp4QualityDocument(filePath:string,size:number,version:string,limits:FlvIndexBuildLimits,check=()=>{},opened?:()=>Promise<void>){
  check();const started=performance.now(),handle=await open(filePath,'r');
  try{
    await opened?.();check();const sourceStat=fileStatWitness(await handle.stat({bigint:true}));
    const verify=async()=>{check();const [fd,current]=await Promise.all([handle.stat(),stat(filePath)]);if(!fd.isFile()||!current.isFile()||fd.size!==size||current.size!==size||fileVersion(fd)!==version||fileVersion(current)!==version||!sameFileStat(sourceStat,fileStatWitness(await handle.stat({bigint:true})))||!sameFileStat(sourceStat,fileStatWitness(await stat(filePath,{bigint:true}))))throw new AdminError(409,'MP4 source changed during preparation.','source-changed');check();};
    await verify();let diskReadBytes=0,diskReadCalls=0;
    const result=await readMp4QualityIndex({size,async read(at,n){check();if(diskReadBytes+n>limits.maxReadBytes)throw new AdminError(413,'MP4 preparation read budget exceeded.','budget-exceeded');const b=new Uint8Array(n);let filled=0;while(filled<n){check();const r=await handle.read(b,filled,n-filled,at+filled);diskReadCalls++;diskReadBytes+=r.bytesRead;check();if(!r.bytesRead)throw new AdminError(409,'MP4 source truncated during preparation.','source-changed');filled+=r.bytesRead;}return b;}},{check,digest:async b=>createHash('sha256').update(b).digest('hex')});
    await verify();if(result.document.samples.length>limits.maxPackets||Buffer.byteLength(JSON.stringify(result.document))>limits.maxIndexBytes)throw new AdminError(413,'MP4 quality index exceeds preparation budget.','budget-exceeded');
    return {document:result.document,profile:{sourceStat,scanMode:'mp4-quality-tables-v1',scannedBytes:size,packets:result.document.samples.length,diskReadBytes,diskReadCalls,totalBuildWallMs:performance.now()-started}};
  }finally{await handle.close();}
}
