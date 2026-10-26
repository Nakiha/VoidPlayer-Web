import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {QualityRangeService}=await import(pathToFileURL(resolve('server/analysis/quality/range-service.ts')).href);
const submit=QualityRangeService.prototype.submit;
QualityRangeService.prototype.submit=function(...args){
  const accepted=submit.apply(this,args),client=args[0]?.client?.id;
  if(client?.startsWith('clock-plan:')){
    writeFileSync(process.env.CLOCK_COMMIT_MARKER,JSON.stringify({planId:client.slice('clock-plan:'.length),job:accepted.job}));
    process.kill(process.pid,'SIGKILL');
  }
  return accepted;
};
