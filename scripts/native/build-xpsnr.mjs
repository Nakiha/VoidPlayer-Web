/** Explicit optional build, using the existing pinned public FFmpeg supplier and
 * cc/make. No package installation, PATH discovery at runtime or system writes. */
import {readFile,mkdir,writeFile,copyFile,chmod} from 'node:fs/promises';
import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..'),lock=JSON.parse(await readFile(new URL('./xpsnr.lock.json',import.meta.url),'utf8'));
if(process.platform!=='linux'||process.arch!=='x64')throw Error('XPSNR component currently builds only on Linux x64');
const out=path.resolve(process.argv[2]??path.join(root,'.run/components/xpsnr')),source=path.resolve(process.env.XPSNR_SOURCE_DIR??path.join(root,'.run/xpsnr-native/source')),build=path.join(out,'build');
const run=(p,a,cwd=root)=>execFileSync(p,a,{cwd,stdio:'inherit'}),git=(args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim(),hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir(out,{recursive:true});
try{git(['rev-parse','HEAD']);}catch{await mkdir(path.dirname(source),{recursive:true});run('git',['clone','--filter=blob:none','--no-checkout',lock.repository,source]);run('git',['-C',source,'checkout','--detach',lock.revision]);}
if(git(['rev-parse','HEAD'])!==lock.revision||git(['status','--porcelain']))throw Error('Supply the clean exact pinned FFmpeg source; existing sources are never checked out or modified');
if(hash(await readFile(path.join(source,'libavfilter/vf_xpsnr.c')))!==lock.filterSha256)throw Error('Pinned XPSNR filter differs');
await mkdir(build,{recursive:true});run(path.join(source,'configure'),lock.options,build);run('make',['-j2','ffmpeg'],build);
await copyFile(path.join(build,'ffmpeg'),path.join(out,'ffmpeg-xpsnr'));await chmod(path.join(out,'ffmpeg-xpsnr'),0o755);
run(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',path.join(root,'scripts/native/vmaf-limit.c'),'-o',path.join(out,'native-limit')]);
const license=execFileSync(path.join(out,'ffmpeg-xpsnr'),['-L'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
if(!license.includes('Lesser General Public License')||license.includes('version 3'))throw Error('Unexpected component license');
// Complete corresponding source and exact configuration travel with the optional component.
execFileSync('git',['-C',source,'archive','--format=tar.gz','--prefix=ffmpeg/','-o',path.join(out,'ffmpeg-source.tar.gz'),lock.revision]);
await copyFile(path.join(root,'scripts/native/vmaf-limit.c'),path.join(out,'native-limit.c'));
const notices='Optional XPSNR executable: FFmpeg '+lock.revision+' (LGPL-2.1-or-later), no GPL/nonfree/version3/external libraries. Complete corresponding source: ffmpeg-source.tar.gz. Build options: manifest.json.\nXPSNR authors Christian Helmrich, Christian Lehmann, Christian Stoffers. https://ffmpeg.org/ffmpeg-filters.html#xpsnr\nNative supervisor source: native-limit.c, LGPL-2.1-or-later.\n\n'+await readFile(path.join(source,'COPYING.LGPLv2.1'),'utf8');
await writeFile(path.join(out,'NOTICES.txt'),notices);
const files={};for(const name of ['ffmpeg-xpsnr','native-limit','native-limit.c','ffmpeg-source.tar.gz','NOTICES.txt'])files[name]=hash(await readFile(path.join(out,name)));
const version=execFileSync(path.join(out,'ffmpeg-xpsnr'),['-version'],{encoding:'utf8'}).split('\n')[0];
const manifest={schema:'voidplayer-native-xpsnr-component',version:1,platform:lock.platform,source:{repository:lock.repository,revision:lock.revision,filterSha256:lock.filterSha256,license:lock.license},build:{options:lock.options,supervisorSourceSha256:files['native-limit.c'],cc:execFileSync(process.env.CC??'cc',['--version'],{encoding:'utf8'}).split('\n')[0]},cliVersion:version,files};
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(out,'manifest.json'),bytes);console.log(JSON.stringify({directory:out,manifestSha256:hash(bytes),installation:'Optional trusted configuration only; no automatic installation.'}));
