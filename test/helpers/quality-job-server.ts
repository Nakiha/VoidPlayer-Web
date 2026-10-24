// Deterministic process lifecycle fixture. No test mode is exposed by the
// production server, HTTP body, environment variables or compiled executable.
import { Worker } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { MediaLibraryIndex } from '../../server/library.ts';
import { LibraryPairRunner } from '../../server/analysis/quality/runner.ts';
import { createMediaServer } from '../../server/app.ts';
const [directory,initialMode='normal']=process.argv.slice(2);
if(!directory)throw Error('Expected test directory');
const library=new MediaLibraryIndex([path.join(directory,'media')],{database:path.join(directory,'library.sqlite'),watch:false});
let mode=initialMode,live=0,total=0;
const states:{id:number;state:Int32Array;announced:boolean;worker:Worker}[]=[];
const runner=new LibraryPairRunner(library,path.resolve('public/vendor/voidplayer-core'),data=>{
 if(data.mode==='source')return new Worker(new URL('../../server/analysis/quality/worker.ts',import.meta.url),{workerData:data});
 const id=++total;live++;let worker:Worker;
 if(mode==='normal')worker=new Worker(new URL('../../server/analysis/quality/worker.ts',import.meta.url),{workerData:data});
 else{
  const state=new Int32Array(new SharedArrayBuffer(20));
  worker=new Worker(new URL('./quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'resolve',phaseState:state.buffer}});
  states.push({id,state,announced:false,worker});
  if(mode==='stop-fails')worker.terminate=async()=>{throw null;};
 }
 console.log(JSON.stringify({event:'worker-start',id,live}));
 worker.once('exit',()=>{live--;console.log(JSON.stringify({event:'worker-exit',id,live}));});return worker;
});
Object.defineProperty(library,'quality',{value:runner});library.qualityJobs;
await library.refresh();const server=createMediaServer({library,roots:library.roots,onLog(){}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({event:'ready',port:(server.address()as {port:number}).port}));
const timer=setInterval(()=>{for(const entry of states)if(!entry.announced&&Atomics.load(entry.state,0)===1){entry.announced=true;console.log(JSON.stringify({event:'worker-blocked',id:entry.id,live}));}},10);
let closing:Promise<void>|undefined;
function close(){return closing??=(async()=>{clearInterval(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await library.close();await runner.close();})();}
createInterface({input:process.stdin}).on('line',line=>{
 if(line==='resume')for(const entry of states)entry.worker.postMessage({type:'resume'});
 else if(line==='gate')mode='gated';else if(line==='normal')mode='normal';
 else if(line==='shutdown')void close().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
});
process.once('SIGTERM',()=>void close().then(()=>process.exit(0),()=>process.exit(1)));
