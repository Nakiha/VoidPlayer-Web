import {ExistingPageClient} from '../server/bridge/existing-client.ts';
import {stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMediaServer} from '../server/app.ts';
import {MediaLibraryIndex} from '../server/library.ts';
import {PageChannel} from '../server/bridge/page-channel.ts';
import {runPageStdio} from '../server/bridge/stdio.ts';

// Keep the ordinary application's diagnostics off the protocol stream.
console.log=console.info=console.debug=(...args:unknown[])=>console.error(...args);
const args=process.argv.slice(2);
if(args[0]==='--existing-origin'){
  if(args.length!==2)throw Error('Usage: --existing-origin <exact loopback origin>');
  const {channel,pairingCode,expiresAt}=await ExistingPageClient.create(args[1]);
  process.stderr.write(`VoidPlayer existing page: ${new URL(args[1]).origin}/\nOne-time pairing (enter only in the intended already-open page MCP panel): ${pairingCode}\nExpires: ${new Date(expiresAt).toISOString()}\nClient name is self-declared. The page must explicitly confirm permissions.\n`);
  runPageStdio(channel,async()=>{channel.close();});
}else{
if(args.length&&!(args.length===2&&args[0]==='--static-dir'))throw Error('Usage: node scripts/mcp-page-bridge.ts [--static-dir <built frontend>]');
const staticDir=path.resolve(args[1]??fileURLToPath(new URL('../dist',import.meta.url)));
if(!(await stat(path.join(staticDir,'index.html')).catch(()=>null))?.isFile())throw Error('Build the frontend first: npm run build');
const html=await readFile(path.join(staticDir,'index.html'),'utf8');
// Temporary storage never advertises durable/background quality jobs here.
// Such jobs belong to the independent normal HTTP service, not this host.
const library=new MediaLibraryIndex([],{database:':memory:',coreDir:path.join(staticDir,'vendor/voidplayer-core'),watch:false});
library.start();
const channel=new PageChannel(html);
const server=createMediaServer({roots:[],library,staticDir,onLog:()=>{},pageBridge:channel});
server.maxConnections=32;server.headersTimeout=3000;server.requestTimeout=5000;server.keepAliveTimeout=2000;
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{channel.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await library.close();})();
try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  channel.origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.stderr.write(`VoidPlayer temporary page: ${channel.origin}/\n`);
  runPageStdio(channel,close);
}catch(error){await close();throw error;}

}
