// Test-only preload: kill only after the real immutable result transaction
// committed, before the parent coordinator can observe another event-loop turn.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {QualityJobStore}=await import(pathToFileURL(resolve('server/analysis/quality/job-store.ts')).href);
const finish=QualityJobStore.prototype.finish;
QualityJobStore.prototype.finish=function(...args){
 const changed=finish.apply(this,args);
 if(changed&&args[2]==='completed'){
  const child=this.get(args[0]);
  if(child.submitted.client.id.startsWith('range:')){
   writeFileSync(process.env.RANGE_COMMIT_MARKER,JSON.stringify(child));
   process.kill(process.pid,'SIGKILL');
  }
 }
 return changed;
};
