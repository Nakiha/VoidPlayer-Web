import {readFile} from 'node:fs/promises';import path from 'node:path';import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
const settings=JSON.parse(await readFile(process.argv[2],'utf8')),config=await loadConfig([],'production',path.dirname(process.argv[2]),{staticDir:path.resolve('public'),dataDir:settings.dataDir,allowEmptyRoots:true});Object.assign(config,{...settings,indexWatch:false,port:0,logsDir:null});const service=await startService(config,false);
if(process.argv[3]==='hold'){
 const runner=service.library.qualityCambi.runner,run=runner.runCambi.bind(runner);
 runner.runCambi=(id,input,signal,hooks)=>run(id,input,signal,{...hooks,streamFrame:async(...args)=>{
  await hooks.streamFrame(...args);console.log(JSON.stringify({event:'analysis-held',streaming:true}));
  await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }});
}
console.log(JSON.stringify({event:'ready',port:service.server.address().port}));process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0),()=>process.exit(1)));
