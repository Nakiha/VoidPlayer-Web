import {readFile,mkdir,writeFile,copyFile,chmod,realpath} from 'node:fs/promises';
import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync,spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..'),lock=JSON.parse(await readFile(new URL('./vmaf.lock.json',import.meta.url),'utf8'));
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Native VMAF component currently builds only on Linux x64');
const out=path.resolve(process.argv[2]??path.join(root,'.run/components/vmaf')),source=path.resolve(process.env.VMAF_SOURCE_DIR??path.join(root,'.run/vmaf-native/source')),build=path.join(out,'build');
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',...options});
await mkdir(out,{recursive:true});
try{execFileSync('git',['-C',source,'rev-parse','HEAD']);}catch{await mkdir(path.dirname(source),{recursive:true});run('git',['clone','--filter=blob:none','--no-checkout',lock.repository,source]);}
run('git',['-C',source,'checkout','--detach',lock.revision]);
const revision=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(revision!==lock.revision||execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim())throw Error('VMAF source must match the clean pinned revision');
let configured=false;try{await readFile(path.join(build,'meson-private/coredata.dat'));configured=true;}catch{}
run(process.env.VMAF_MESON??'meson',['setup',...(configured?['--reconfigure']:[]),build,path.join(source,'libvmaf'),...lock.options]);
run(process.env.VMAF_NINJA??'ninja',['-C',build,'-j2']);
await copyFile(path.join(build,'tools/vmaf'),path.join(out,'vmaf'));await chmod(path.join(out,'vmaf'),0o755);
run(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',path.join(root,'scripts/native/vmaf-limit.c'),'-o',path.join(out,'vmaf-limit')]);
const files={};const digest=b=>createHash('sha256').update(b).digest('hex');
for(const [id,model]of Object.entries(lock.models)){const bytes=await readFile(path.join(source,'model',model.file));if(digest(bytes)!==model.sha256)throw Error(`Pinned ${id} model mismatch`);await writeFile(path.join(out,model.file),bytes);files[model.file]=model.sha256;}
for(const name of ['vmaf','vmaf-limit'])files[name]=digest(await readFile(path.join(out,name)));
const notices=(await readFile(path.join(source,'LICENSE'),'utf8'))+'\n\nLIBSVM notice:\n'+(await readFile(path.join(source,'libvmaf/src/svm.h'),'utf8')).split('#ifndef')[0];
await writeFile(path.join(out,'NOTICES.txt'),notices);files['NOTICES.txt']=digest(Buffer.from(notices));
const versionRun=spawnSync(path.join(out,'vmaf'),['--version'],{encoding:'utf8'});
if(versionRun.status!==0||versionRun.signal)throw Error('Official VMAF version command failed');
const cliVersion=(versionRun.stdout+versionRun.stderr).trim();if(cliVersion!=='17a67b2')throw Error('Unexpected fixed VMAF version');
const manifest={schema:'voidplayer-native-vmaf-component',version:1,platform:lock.platform,source:{repository:lock.repository,revision,tag:lock.tag},build:{options:lock.options,cc:execFileSync(process.env.CC??'cc',['--version'],{encoding:'utf8'}).split('\n')[0],meson:execFileSync(process.env.VMAF_MESON??'meson',['--version'],{encoding:'utf8'}).trim()},cliVersion,files};
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(out,'manifest.json'),bytes);
console.log(JSON.stringify({directory:await realpath(out),manifestSha256:digest(bytes),installation:'Copy this component directory and pin its manifestSha256 in the trusted service configuration. Never accept paths from HTTP.'},null,2));
