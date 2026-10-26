/** Explicit native test prerequisite. The application never downloads/builds a
 * component. All failures remain failures; a corrupt existing component is not
 * silently replaced or accepted. No workflow or remote cache settings change. */
import {access,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {verifyVmafComponent} from '../../server/analysis/vmaf/component.ts';
const root=path.resolve(import.meta.dirname,'../..'),directory=path.resolve(process.env.VOIDPLAYER_VMAF_COMPONENT??path.join(root,'.run/components/vmaf'));
let exists=false;try{await access(path.join(directory,'manifest.json'));exists=true;}catch{}
const run=(program,args)=>{const r=spawnSync(program,args,{cwd:root,stdio:'inherit',env:process.env});if(r.error)throw r.error;if(r.status!==0||r.signal)throw Error(`Native VMAF prerequisite/test failed (${r.status??r.signal})`);};
if(!exists)run(process.execPath,[path.join(root,'scripts/native/prepare-vmaf.mjs'),directory]);
const manifestSha256=createHash('sha256').update(await readFile(path.join(directory,'manifest.json'))).digest('hex');await verifyVmafComponent({directory,manifestSha256},'vmaf_v0_6_1');
const [program,...args]=process.argv.slice(2);if(!program)throw Error('Pass an explicit test command');run(program==='node'?process.execPath:program,args);
