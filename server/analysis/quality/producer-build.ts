import {createHash} from 'node:crypto';
import {readdirSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REEXECUTION_LIMITS} from '../../../shared/analysis/quality/reexecution.ts';
declare const VOIDPLAYER_QUALITY_PRODUCER_SHA256:string;
declare const VOIDPLAYER_QUALITY_PRODUCER_BYTES:number;
/** Hash only public application implementation files, never config, data,
 * credentials or working-tree metadata. The packager embeds this same digest.
 * A source deployment is read inside the existing owned Worker IO fence. */
export function hashQualityProducer(root:string,check=()=>{}){
  const names:string[]=[];
  const walk=(relative:string)=>{check();for(const entry of readdirSync(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory())walk(name);else if(entry.isFile()&&entry.name.endsWith('.ts')){names.push(name);if(names.length>1024)throw Error('Producer file-count budget exceeded');}}};
  walk('server');walk('shared');names.sort();const hash=createHash('sha256');let bytes=0;
  for(const name of names){check();const fd=openSync(path.join(root,name),'r');try{const before=fstatSync(fd);bytes+=before.size;if(bytes>REEXECUTION_LIMITS.maxProducerBytes)throw Error('Producer byte budget exceeded');hash.update(name+'\0'+before.size+'\0');const scratch=Buffer.alloc(Math.min(before.size,65536));let offset=0;while(offset<before.size){check();const n=readSync(fd,scratch,0,Math.min(scratch.length,before.size-offset),offset);if(!n)throw Error('Producer changed while reading');hash.update(scratch.subarray(0,n));offset+=n;}const after=fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('Producer changed while reading');}finally{closeSync(fd);}}
  return {sha256:hash.digest('hex'),bytes};
}
export function qualityProducerBuild(control:Int32Array,check:()=>void){
  if(typeof VOIDPLAYER_QUALITY_PRODUCER_SHA256!=='undefined')return {kind:'compiled-content' as const,sha256:VOIDPLAYER_QUALITY_PRODUCER_SHA256,bytes:VOIDPLAYER_QUALITY_PRODUCER_BYTES};
  Atomics.add(control,1,1);try{return {kind:'source-content' as const,...hashQualityProducer(fileURLToPath(new URL('../../../',import.meta.url)),check)};}finally{Atomics.sub(control,1,1);Atomics.notify(control,1);}
}
