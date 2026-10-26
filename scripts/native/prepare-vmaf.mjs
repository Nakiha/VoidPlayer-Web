/** Build an optional component from the public pinned source. Never install into
 * a system directory or change service configuration on the user's behalf. */
import {mkdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),lock=JSON.parse(await readFile(new URL('./vmaf.lock.json',import.meta.url),'utf8'));
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Native VMAF component is currently Linux x64 only');
const tools=path.join(root,'.run/vmaf-native/tools');await mkdir(path.dirname(tools),{recursive:true});
const run=(program,args,env=process.env)=>{const r=spawnSync(program,args,{cwd:root,stdio:'inherit',env});if(r.status!==0||r.signal)throw Error(`${path.basename(program)} failed (${r.status??r.signal})`);};
run('python3',['-m','venv',tools]);run(path.join(tools,'bin/python'),['-m','pip','install','--disable-pip-version-check',`meson==${lock.meson}`,`ninja==${lock.ninja}`]);
run(process.execPath,[path.join(root,'scripts/native/build-vmaf.mjs'),process.argv[2]??path.join(root,'.run/components/vmaf')],{...process.env,VMAF_MESON:path.join(tools,'bin/meson'),VMAF_NINJA:path.join(tools,'bin/ninja'),PATH:path.join(tools,'bin')+path.delimiter+process.env.PATH});
