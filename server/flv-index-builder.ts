import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { scanFlv } from '../src/flv-demux.ts';
import type { FlvScanReader } from '../src/flv-demux.ts';
import { serializeFlvIndex } from '../src/flv-index-cache.ts';
import { fileVersion } from './library.ts';
import { AdminError } from './admin-error.ts';
import type { FfmpegIndexBuildProgress } from './frame-index-builder.ts';

const BLOCK_BYTES=1024*1024;
/** Disk-only adapter; the parser, recovery rules and index assembly are shared with the client. */
class DiskFlvReader implements FlvScanReader {
  private blocks=new Map<number,Uint8Array>();
  readCalls=0;readBytes=0;
  private handle:FileHandle;
  readonly size:number;
  constructor(handle:FileHandle,size:number){this.handle=handle;this.size=size;}
  async read(offset:number,length:number):Promise<Uint8Array>{
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>64*1024*1024||offset+length>this.size)throw new Error('FLV 磁盘读取范围无效。');
    const result=new Uint8Array(length);
    for(let at=offset;at<offset+length;){
      const start=Math.floor(at/BLOCK_BYTES)*BLOCK_BYTES;
      let block=this.blocks.get(start);
      if(!block){
        block=new Uint8Array(Math.min(BLOCK_BYTES,this.size-start));let filled=0;
        while(filled<block.length){
          const read=await this.handle.read(block,filled,block.length-filled,start+filled);
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

export async function buildFlvIndexDocument(filePath:string,size:number,version:string,onProgress?:(data:FfmpegIndexBuildProgress)=>void){
  const started=performance.now(),cpu=process.cpuUsage(),handle=await open(filePath,'r');
  const assertVersion=async()=>{
    const [opened,current]=await Promise.all([handle.stat(),stat(filePath)]);
    if(opened.size!==size||current.size!==size||fileVersion(opened)!==version||fileVersion(current)!==version)throw new AdminError(409,'FLV 文件在索引期间改变，未保存旧版本索引。');
  };
  try{
    await assertVersion();const reader=new DiskFlvReader(handle,size);
    onProgress?.({phase:'scan',packets:0,scannedBytes:0,totalBytes:size});
    const scanned=await scanFlv(reader,undefined,undefined,false,checkpoint=>{
      onProgress?.({phase:'scan',packets:checkpoint.index.packets.length,scannedBytes:checkpoint.nextOffset,totalBytes:size});
    });
    await assertVersion();
    const document=serializeFlvIndex(scanned.index,size);
    onProgress?.({phase:'scan',packets:scanned.index.packets.length,scannedBytes:scanned.nextOffset,totalBytes:size});
    const used=process.cpuUsage(cpu);
    return {document,profile:{scanMode:'flv-shared-parser',totalBuildWallMs:performance.now()-started,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,
      scannedBytes:scanned.nextOffset,packets:scanned.index.packets.length,diskReadCalls:reader.readCalls,diskReadBytes:reader.readBytes}};
  }finally{await handle.close();}
}
