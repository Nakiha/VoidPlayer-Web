import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,stat,readdir,unlink,utimes } from 'node:fs/promises';
import path from 'node:path';
import { BUDGET,validateResult } from '../../src/bitstream-analysis/contract.ts';
import type { AnalysisResult } from '../../src/bitstream-analysis/contract.ts';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Each picture is one independently committed chunk. No incomplete chunk is visible. */
export class AnalysisStore {
 readonly directory:string;readonly quota:number;
 constructor(directory:string,quota=128*1024*1024){this.directory=directory;this.quota=quota;}
 private filename(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid analysis chunk');return path.join(this.directory,id+'.json');}
 async get(id:string):Promise<AnalysisResult|null>{
  const file=this.filename(id),s=await stat(file).catch(()=>null);if(!s)return null;
  if(s.size>BUDGET.resultBytes){await unlink(file);return null;}
  try{const envelope=JSON.parse(await readFile(file,'utf8'));if(typeof envelope.payload!=='string'||digest(envelope.payload)!==envelope.checksum)throw new Error('Analysis checksum mismatch');const result=JSON.parse(envelope.payload);validateResult(result);if(result.confidence!=='exact')throw new Error('Incomplete analysis chunk');await utimes(file,new Date(),new Date());return result;}catch{await unlink(file).catch(()=>{});return null;}
 }
 async manifest(id:string):Promise<string[]|null>{const file=this.filename(id)+'.manifest';const size=await stat(file).catch(()=>null);if(!size||size.size>4096)return null;try{const value=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(value.chunks)||value.chunks.length>32||value.chunks.some((id:unknown)=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||digest(JSON.stringify(value.chunks))!==value.checksum)return null;for(const chunk of value.chunks)if(!await this.get(chunk))return null;return value.chunks;}catch{return null;}}
 async putManifest(id:string,chunks:string[]){if(!chunks.length||chunks.length>32)throw new Error('Analysis manifest budget exceeded');await mkdir(this.directory,{recursive:true});const target=this.filename(id)+'.manifest',temp=target+'.tmp';try{await writeFile(temp,JSON.stringify({chunks,checksum:digest(JSON.stringify(chunks))}));await rename(temp,target);}finally{await unlink(temp).catch(()=>{});}}
 async put(id:string,result:AnalysisResult){
  validateResult(result);if(result.confidence!=='exact')return;
  const payload=JSON.stringify(result),envelope=JSON.stringify({checksum:digest(payload),payload}),bytes=Buffer.byteLength(envelope);
  if(bytes>BUDGET.resultBytes||bytes>this.quota)throw new Error('Analysis cache quota exceeded');
  await mkdir(this.directory,{recursive:true});const files=[] as {file:string;bytes:number;mtime:number}[];
  for(const name of await readdir(this.directory)){if(!/^[a-f0-9]{64}\.json(?:\.manifest)?$/.test(name))continue;const file=path.join(this.directory,name),s=await stat(file);files.push({file,bytes:s.size,mtime:s.mtimeMs});}
  files.sort((a,b)=>a.mtime-b.mtime);let total=files.reduce((n,f)=>n+f.bytes,0);
  while((total+bytes>this.quota||files.length>=1024)&&files.length){const old=files.shift()!;await unlink(old.file);total-=old.bytes;}
  const temp=path.join(this.directory,randomUUID()+'.tmp');try{await writeFile(temp,envelope,{flag:'wx'});await rename(temp,this.filename(id));}finally{await unlink(temp).catch(()=>{});}
 }
}
