import {stat,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMediaServer} from '../server/app.ts';
import {MediaLibraryIndex} from '../server/library.ts';
import {PageChannel} from '../server/bridge/page-channel.ts';
import {runPageStdio} from '../server/bridge/stdio.ts';

// Keep the ordinary application's diagnostics off the protocol stream.
console.log=console.info=console.debug=(...args:unknown[])=>console.error(...args);
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--static-dir'))throw Error('Usage: node scripts/mcp-page-bridge.ts [--static-dir <built frontend>]');
const staticDir=path.resolve(args[1]??new URL('../dist',import.meta.url).pathname);
if(!(await stat(path.join(staticDir,'index.html')).catch(()=>null))?.isFile())throw Error('Build the frontend first: npm run build');
const temporary=await mkdtemp(path.join(os.tmpdir(),'voidplayer-page-bridge-'));
const library=new MediaLibraryIndex([],{database:path.join(temporary,'library.sqlite'),coreDir:path.join(staticDir,'vendor/voidplayer-core'),watch:false});
const channel=new PageChannel(staticDir);
const server=createMediaServer({roots:[],library,staticDir,onLog:()=>{},pageBridge:channel});
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{channel.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await library.close();await rm(temporary,{recursive:true,force:true});})();
try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  channel.origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.stderr.write(`VoidPlayer temporary page: ${channel.origin}/\n`);
  runPageStdio(channel,close);
}catch(error){await close();throw error;}
