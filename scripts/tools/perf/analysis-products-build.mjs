import path from 'node:path';
import {build} from 'vite';
// Identical access-only instrumentation in both builds. No serialization,
// validation bypass, timing wrappers or product changes enter the baseline.
for(const directory of process.argv.slice(2)){
 const root=path.resolve(directory);
 await build({root,configFile:path.join(root,'vite.config.ts'),build:{outDir:path.join(root,'.run/perf-dist')},plugins:[{
  name:'analysis-products-paired-session-access',
  transform(code,id){if(id.split('?')[0]===path.join(root,'src/main.ts'))return code+'\nObject.defineProperty(window,"__perfSession",{value:session});';},
 }]});
}
