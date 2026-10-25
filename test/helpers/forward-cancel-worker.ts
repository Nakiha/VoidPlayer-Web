/** Test-only pause after the third REAL native packet send. No HTTP flag. */
import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
import {instantiateCore} from '../../shared/wasm/core.ts';
import {createPairDecoder} from '../../shared/analysis/quality/wasm-decoder.ts';
import {measureFlvFramePair} from '../../shared/analysis/quality/frame-pair.ts';
import {blobPairSource} from '../../src/analysis/quality/source.ts';
parentPort!.once('message',async data=>{
 try{const sources=data.sources.map(blobPairSource);
  const result=await measureFlvFramePair(data.request,[sources[0],sources[1]],budget=>createPairDecoder(async()=>{
   const file=resolve('public/vendor/voidplayer-core/voidplayer-core.js'),glue=await import(pathToFileURL(file).href),loaded=await instantiateCore(glue.default,new Uint8Array(await readFile(file.replace(/\.js$/,'.wasm'))),budget.maxHeapBytes);
   const native=loaded.core.ccall.bind(loaded.core);let sends=0;
   loaded.core.ccall=(name:string,...args:unknown[])=>{const value=native(name,...args);if(name==='vp_packet_send'&&(args[2]as unknown[])[4]===0&&++sends===3){parentPort!.postMessage({decodeBoundary:3});Atomics.wait(new Int32Array(workerData.gate),0,0);}return value;};return loaded;
  }),new AbortController().signal);parentPort!.postMessage({ok:true,result});
 }catch(error){parentPort!.postMessage({ok:false,error:String(error)});}
});
