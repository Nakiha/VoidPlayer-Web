import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { scanFlv } from '../shared/media/containers/flv-demux.ts';
import type { FlvScanReader } from '../shared/media/containers/flv-demux.ts';
import { serializeFlvIndex } from '../shared/media/indexing/flv-index-cache.ts';
import { fileVersion } from './library.ts';
import { AdminError } from './admin-error.ts';
import { fileStatWitness, sameFileStat } from './file-stat.ts';
import type { FfmpegIndexBuildProgress } from './frame-index-builder.ts';

const BLOCK_BYTES=1024*1024;
export type FlvIndexBuildLimits={maxReadBytes:number;maxPackets:number;maxIndexBytes:number};
/** Disk-only adapter; the parser, recovery rules and index assembly are shared with the client. */
class DiskFlvReader implements FlvScanReader {
  private blocks=new Map<number,Uint8Array>();
  readCalls=0;readBytes=0;
  private handle:FileHandle;
  readonly size:number;
  private limits?:FlvIndexBuildLimits;
  private check:()=>void;
  constructor(handle:FileHandle,size:number,limits?:FlvIndexBuildLimits,check=()=>{}){this.handle=handle;this.size=size;this.limits=limits;this.check=check;}
  async read(offset:number,length:number):Promise<Uint8Array>{
    this.check();
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>64*1024*1024||offset+length>this.size)throw new Error('FLV 磁盘读取范围无效。');
    const result=new Uint8Array(length);
    for(let at=offset;at<offset+length;){
      const start=Math.floor(at/BLOCK_BYTES)*BLOCK_BYTES;
      let block=this.blocks.get(start);
      if(!block){
        block=new Uint8Array(Math.min(BLOCK_BYTES,this.size-start));let filled=0;
        while(filled<block.length){
          this.check();if(this.limits&&this.readBytes+block.length-filled>this.limits.maxReadBytes)throw new AdminError(413,'Explicit FLV build read budget exceeded.','budget-exceeded');
          const read=await this.handle.read(block,filled,block.length-filled,start+filled);
          this.check();
          this.readCalls++;this.readBytes+=read.bytesRead;
          if(!read.bytesRead)throw new AdminError(409,'FLV 文件在扫描期间截断或读取不完整。');
          filled+=read.bytesRead;
        }
      }
      this.blocks.delete(start);this.blocks.set(start,block);
      while(this.blocks.size>2)this.blocks.delete(this.blocks.keys().next().value!);
      const count=Math.min(block.length-(at-start),offset+length-at);
      result.set(block.subarray(at-start,at-start+count),at-offset);at+=count;
    }
    return result;
  }
}

export async function buildFlvIndexDocument(filePath:string,size:number,version:string,onProgress?:(data:FfmpegIndexBuildProgress)=>void,limits?:FlvIndexBuildLimits,check=()=>{},opened?:()=>Promise<void>){
  check();
  const started=performance.now(),cpu=process.cpuUsage(),handle=await open(filePath,'r');
  try{
  check();
  await opened?.();check();
  const sourceStat=fileStatWitness(await handle.stat({bigint:true}));
  const assertVersion=async()=>{
    check();
    const [opened,current]=await Promise.all([handle.stat(),stat(filePath)]);
    check();
    if(opened.size!==size||current.size!==size||fileVersion(opened)!==version||fileVersion(current)!==version)throw new AdminError(409,'FLV 文件在索引期间改变，未保存旧版本索引。');
    if(!sameFileStat(sourceStat,fileStatWitness(await handle.stat({bigint:true})))||!sameFileStat(sourceStat,fileStatWitness(await stat(filePath,{bigint:true}))))throw new AdminError(409,'FLV precise file identity changed during indexing.');
    check();
  };
    await assertVersion();const reader=new DiskFlvReader(handle,size,limits,check);
    onProgress?.({phase:'scan',packets:0,scannedBytes:0,totalBytes:size});
    const scanned=await scanFlv(reader,undefined,undefined,false,checkpoint=>{
      check();if(limits&&checkpoint.index.packets.length>limits.maxPackets)throw new AdminError(413,'Explicit FLV build packet budget exceeded.','budget-exceeded');
      onProgress?.({phase:'scan',packets:checkpoint.index.packets.length,scannedBytes:checkpoint.nextOffset,totalBytes:size});
    });
    await assertVersion();
    const document=serializeFlvIndex(scanned.index,size);
    check();if(limits&&(scanned.index.packets.length>limits.maxPackets||Buffer.byteLength(JSON.stringify(document))>limits.maxIndexBytes))throw new AdminError(413,'Explicit FLV build index budget exceeded.','budget-exceeded');
    onProgress?.({phase:'scan',packets:scanned.index.packets.length,scannedBytes:scanned.nextOffset,totalBytes:size});
    const used=process.cpuUsage(cpu);
    return {document,profile:{sourceStat,scanMode:'flv-shared-parser',totalBuildWallMs:performance.now()-started,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,
      scannedBytes:scanned.nextOffset,packets:scanned.index.packets.length,diskReadCalls:reader.readCalls,diskReadBytes:reader.readBytes}};
  }finally{await handle.close();}
}
