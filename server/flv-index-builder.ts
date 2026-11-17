import { openVersionedInput, type MediaInput } from './versioned-input.ts';
import { scanFlv } from '../shared/media/containers/flv-demux.ts';
import type { FlvScanReader } from '../shared/media/containers/flv-demux.ts';
import { serializeFlvIndex } from '../shared/media/indexing/flv-index-cache.ts';
import { AdminError } from './admin-error.ts';
import type { FfmpegIndexBuildProgress } from './frame-index-builder.ts';

type IndexInput = Awaited<ReturnType<typeof openVersionedInput>>;
const BLOCK_BYTES=1024*1024;
export type FlvIndexBuildLimits={maxReadBytes:number;maxPackets:number;maxIndexBytes:number};
/** Bounded byte reader; the parser, recovery rules and index assembly are shared with the client. */
class BufferedFlvReader implements FlvScanReader {
  private blocks=new Map<number,Uint8Array>();
  readCalls=0;readBytes=0;
  private handle:IndexInput;
  readonly size:number;
  private limits?:FlvIndexBuildLimits;
  private check:()=>void;
  constructor(handle:IndexInput,size:number,limits?:FlvIndexBuildLimits,check=()=>{}){this.handle=handle;this.size=size;this.limits=limits;this.check=check;}
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

export async function buildFlvIndexDocument(input:MediaInput,size:number,version:string,onProgress?:(data:FfmpegIndexBuildProgress)=>void,limits?:FlvIndexBuildLimits,check=()=>{},opened?:()=>Promise<void>){
  check();
  const started=performance.now(),cpu=process.cpuUsage(),handle=await openVersionedInput(input,size,version,true);
  try{
    check();
    await opened?.();
    check();
    await handle.verify();
    check();
    const reader=new BufferedFlvReader(handle,size,limits,check);
    onProgress?.({phase:'scan',packets:0,scannedBytes:0,totalBytes:size});
    const scanned=await scanFlv(reader,undefined,undefined,false,checkpoint=>{
      check();if(limits&&checkpoint.index.packets.length>limits.maxPackets)throw new AdminError(413,'Explicit FLV build packet budget exceeded.','budget-exceeded');
      onProgress?.({phase:'scan',packets:checkpoint.index.packets.length,scannedBytes:checkpoint.nextOffset,totalBytes:size});
    });
    await handle.verify();
    const document=serializeFlvIndex(scanned.index,size);
    check();if(limits&&(scanned.index.packets.length>limits.maxPackets||Buffer.byteLength(JSON.stringify(document))>limits.maxIndexBytes))throw new AdminError(413,'Explicit FLV build index budget exceeded.','budget-exceeded');
    onProgress?.({phase:'scan',packets:scanned.index.packets.length,scannedBytes:scanned.nextOffset,totalBytes:size});
    const used=process.cpuUsage(cpu);
    return {document,profile:{sourceStat:handle.witness,scanMode:'flv-shared-parser',totalBuildWallMs:performance.now()-started,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,
      scannedBytes:scanned.nextOffset,packets:scanned.index.packets.length,diskReadCalls:reader.readCalls,diskReadBytes:reader.readBytes}};
  }finally{await handle.close();}
}
