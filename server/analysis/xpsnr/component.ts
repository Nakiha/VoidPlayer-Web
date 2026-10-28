import {readFile,stat,realpath} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {XPSNR_SOURCE_REVISION,XPSNR_FILTER_SHA256,XPSNR_SUPERVISOR_SOURCE_SHA256,XpsnrError} from '../../../shared/analysis/quality/xpsnr.ts';
import type {XpsnrComponentConfig} from '../../../shared/analysis/quality/xpsnr.ts';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export type XpsnrComponent={directory:string;manifestSha256:string;binary:string;supervisor:string;binarySha256:string;filterSha256:string;supervisorSha256:string;cliVersion:string;sourceRevision:string};
export async function verifyXpsnrComponent(config:XpsnrComponentConfig|undefined):Promise<XpsnrComponent>{
 if(!config||process.platform!=='linux'||process.arch!=='x64')throw new XpsnrError('component-unavailable','Native XPSNR requires an explicitly configured trusted Linux x64 component');
 if(!path.isAbsolute(config.directory)||!/^[a-f0-9]{64}$/.test(config.manifestSha256))throw new XpsnrError('component-unavailable','Invalid trusted XPSNR configuration');
 try{
  const directory=await realpath(config.directory),file=path.join(directory,'manifest.json');if((await stat(file)).size>32768)throw Error('Manifest exceeds limit');
  const bytes=await readFile(file);if(hash(bytes)!==config.manifestSha256)throw Error('Manifest differs from trusted host configuration');const m=JSON.parse(bytes.toString());
  const options=['--disable-autodetect','--disable-everything','--disable-doc','--disable-debug','--disable-network','--disable-gpl','--disable-version3','--disable-nonfree','--disable-x86asm','--disable-asm','--disable-shared','--enable-static','--disable-ffplay','--disable-ffprobe','--enable-ffmpeg','--enable-protocol=file,pipe','--enable-demuxer=rawvideo','--enable-decoder=rawvideo','--enable-filter=xpsnr','--enable-muxer=null','--enable-encoder=wrapped_avframe'];
  if(m.schema!=='voidplayer-native-xpsnr-component'||m.version!==1||m.platform!=='linux-x64'||m.source?.revision!==XPSNR_SOURCE_REVISION||m.source.repository!=='https://github.com/Nakiha/FFmpeg.git'||m.source.filterSha256!==XPSNR_FILTER_SHA256||m.source.license!=='LGPL-2.1-or-later'||m.build?.supervisorSourceSha256!==XPSNR_SUPERVISOR_SOURCE_SHA256||JSON.stringify(m.build.options)!==JSON.stringify(options)||typeof m.cliVersion!=='string'||!m.cliVersion.startsWith('ffmpeg version '))throw Error('Unpinned XPSNR implementation/build/license');
  for(const name of ['ffmpeg-xpsnr','native-limit','native-limit.c','NOTICES.txt','ffmpeg-source.tar.gz']){
   const p=path.join(directory,name);if(await realpath(p)!==p)throw Error('Component files cannot be symlinks');const s=await stat(p);
   if(!s.isFile()||s.size<1||s.size>(name==='ffmpeg-source.tar.gz'?64:16)*1024*1024)throw Error('Component file exceeds budget');
   const h=hash(await readFile(p));if(h!==m.files?.[name]||name==='native-limit.c'&&h!==XPSNR_SUPERVISOR_SOURCE_SHA256)throw Error('Component hash mismatch');
   if(['ffmpeg-xpsnr','native-limit'].includes(name)&&!(s.mode&0o111))throw Error('Component is not executable');
  }
  return {directory,manifestSha256:config.manifestSha256,binary:path.join(directory,'ffmpeg-xpsnr'),supervisor:path.join(directory,'native-limit'),binarySha256:m.files['ffmpeg-xpsnr'],filterSha256:XPSNR_FILTER_SHA256,supervisorSha256:m.files['native-limit'],cliVersion:m.cliVersion,sourceRevision:XPSNR_SOURCE_REVISION};
 }catch(error){throw new XpsnrError('component-unavailable',`XPSNR component verification failed: ${(error as Error).message}`);}
}
