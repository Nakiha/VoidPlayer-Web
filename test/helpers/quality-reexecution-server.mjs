// Test-only process boundary. Both crash sites follow real SQLite mutations;
// SIGKILL cannot yield to a parent poll or manufacture a response receipt.
import {readFileSync,writeFileSync} from 'node:fs';
import {loadConfig} from '../../server/config.ts';
import {startService} from '../../server/runtime.ts';
import {ReexecutionLedger} from '../../server/analysis/quality/reexecution-ledger.ts';
import {QualityReexecutionService} from '../../server/analysis/quality/reexecution-service.ts';
const [settings,mode,marker]=process.argv.slice(2),config=JSON.parse(readFileSync(settings,'utf8'));
if(mode==='before-commit'){
 const insert=ReexecutionLedger.prototype.insert;
 ReexecutionLedger.prototype.insert=function(receipt){insert.call(this,receipt);writeFileSync(marker,JSON.stringify(receipt));process.kill(process.pid,'SIGKILL');};
}
if(mode==='after-commit'){
 const execute=QualityReexecutionService.prototype.execute;
 QualityReexecutionService.prototype.execute=async function(...args){const result=await execute.apply(this,args);writeFileSync(marker,JSON.stringify(result.receipt));process.kill(process.pid,'SIGKILL');return result;};
}
const resolved=await loadConfig([],'production',process.cwd(),{staticDir:config.staticDir,dataDir:config.dataDir,allowEmptyRoots:true});Object.assign(resolved,config,{port:0,indexWatch:false,logsDir:null});
const service=await startService(resolved,false),create=service.library.quality.createWorker;
service.library.quality.createWorker=data=>{if(data.mode==='measure')console.log(JSON.stringify({event:'measure-start'}));return create(data);};
console.log(JSON.stringify({event:'ready',port:service.server.address().port}));
process.once('SIGTERM',()=>void service.close().then(()=>process.exit(0),()=>process.exit(1)));
