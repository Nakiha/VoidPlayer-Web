import {readFile} from 'node:fs/promises';import path from 'node:path';
import {loadConfig} from '../../server/config.ts';import {startService} from '../../server/runtime.ts';
const settings=JSON.parse(await readFile(process.argv[2],'utf8')),config=await loadConfig([],'production',path.dirname(process.argv[2]),{staticDir:path.resolve('public'),dataDir:settings.dataDir,allowEmptyRoots:true});Object.assign(config,{...settings,indexWatch:false,port:0,logsDir:null});
const service=await startService(config,false);
const runner=service.library.qualityXpsnr.runner,run=runner.run.bind(runner);runner.run=(input,snapshot,signal,hooks)=>{console.log(JSON.stringify({event:'native-execution-start',plan:snapshot.id}));return run(input,snapshot,signal,{...hooks,process:p=>{hooks.process(p);if(p){console.log(JSON.stringify({event:'native-owned',process:p}));if(process.argv[3]==='hold'){process.kill(p.pid,'SIGSTOP');console.log(JSON.stringify({event:'native-held',process:p}));}}}});};
console.log(JSON.stringify({event:'ready',port:service.server.address().port}));
process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0),()=>process.exit(1)));
