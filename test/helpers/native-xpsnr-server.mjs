import {readFile} from 'node:fs/promises';import path from 'node:path';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
const settings=JSON.parse(await readFile(process.argv[2],'utf8')),config=await loadConfig([],'production',path.dirname(process.argv[2]),{staticDir:path.resolve('public'),dataDir:settings.dataDir,allowEmptyRoots:true});Object.assign(config,{...settings,indexWatch:false,port:0,logsDir:null});
const service=await startService(config,false);
const runner=service.library.qualityXpsnr.runner,run=runner.run.bind(runner),worker=runner.worker.bind(runner);
runner.run=(...args)=>{console.log(JSON.stringify({event:'analysis-execution-start'}));return run(...args);};
runner.worker=async(entry,data,signal,...rest)=>{
 if(process.argv[3]==='hold'&&data.mode==='verify'){
  console.log(JSON.stringify({event:'analysis-held',prepared:true}));
  await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }
 return worker(entry,data,signal,...rest);
};
console.log(JSON.stringify({event:'ready',port:service.server.address().port}));
process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0),()=>process.exit(1)));
