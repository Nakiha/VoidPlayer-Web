/** Compatibility entry for the former native suites. Product scoring consumes
 * the pinned analysis artifact; independent CLI outputs are committed oracles.
 * Fixture generation remains an explicit maintainer action, never a test-time
 * download or native component installation. */
import path from 'node:path';import {spawnSync} from 'node:child_process';
import {analysisComponent} from '../../server/analysis/quality/analysis-component.ts';
const root=path.resolve(import.meta.dirname,'../..');
analysisComponent(path.join(root,'public/vendor/voidplayer-analysis'));
const [program,...args]=process.argv.slice(2);if(!program)throw Error('Pass an explicit test command');
const result=spawnSync(program==='node'?process.execPath:program,args,{cwd:root,stdio:'inherit',env:process.env});
if(result.error)throw result.error;if(result.status!==0||result.signal)throw Error(`Analysis scoring regression failed (${result.status??result.signal})`);
