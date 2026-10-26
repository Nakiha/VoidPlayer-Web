import {readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';import {createHash} from 'node:crypto';
import {VMAF_MODELS,VMAF_SOURCE_REVISION,VmafError} from '../../../shared/analysis/quality/vmaf.ts';
import type {VmafComponentConfig,VmafModel} from '../../../shared/analysis/quality/vmaf.ts';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export type VmafComponent={directory:string;manifestSha256:string;binary:string;supervisor:string;model:string;binarySha256:string;modelSha256:string;supervisorSha256:string;cliVersion:string;sourceRevision:string};
export async function verifyVmafComponent(config:VmafComponentConfig|undefined,model:VmafModel):Promise<VmafComponent>{
 if(process.platform!=='linux'||process.arch!=='x64')throw new VmafError('component-unavailable','Native VMAF currently supports only Linux x64');
 if(!config)throw new VmafError('component-unavailable','Install a trusted native VMAF component and pin its manifest digest in the service configuration');
 if(!path.isAbsolute(config.directory)||!/^[a-f0-9]{64}$/.test(config.manifestSha256))throw new VmafError('component-unavailable','Invalid trusted component configuration');
 try{
  const directory=await realpath(config.directory),file=path.join(directory,'manifest.json');
  if((await stat(file)).size>32768)throw Error('Manifest exceeds limit');
  const bytes=await readFile(file);if(hash(bytes)!==config.manifestSha256)throw Error('Component manifest hash differs from service configuration');
  const m=JSON.parse(bytes.toString());
  if(m.schema!=='voidplayer-native-vmaf-component'||m.version!==1||m.platform!=='linux-x64'||m.source?.revision!==VMAF_SOURCE_REVISION||m.source?.repository!=='https://github.com/Netflix/vmaf.git'||m.cliVersion!=='17a67b2')throw Error('Unsupported component provenance/version');
  const expected=['--buildtype=release','--default-library=static','-Db_ndebug=true','-Denable_tests=false','-Denable_docs=false','-Denable_asm=false','-Denable_avx512=false','-Dbuilt_in_models=false','-Denable_float=false','-Denable_cuda=false','-Denable_nvtx=false'];
  if(JSON.stringify(m.build?.options)!==JSON.stringify(expected))throw Error('Native build recipe changed');
  for(const name of ['vmaf','vmaf-limit','NOTICES.txt',...Object.values(VMAF_MODELS).map(v=>v.file)]){
   const p=path.join(directory,name);if(await realpath(p)!==p)throw Error('Component file must not be a symlink');const s=await stat(p);
   if(!s.isFile()||s.size<1||s.size>16*1024*1024)throw Error('Component file size invalid');
   const h=hash(await readFile(p));if(m.files?.[name]!==h)throw Error(`Component ${name} hash mismatch`);
   const model=Object.values(VMAF_MODELS).find(v=>v.file===name);if(model&&model.sha256!==h)throw Error('Pinned model mismatch');
   if(['vmaf','vmaf-limit'].includes(name)&&!(s.mode&0o111))throw Error('Native component is not executable');
  }
  return {directory,manifestSha256:config.manifestSha256,binary:path.join(directory,'vmaf'),supervisor:path.join(directory,'vmaf-limit'),model:path.join(directory,VMAF_MODELS[model].file),binarySha256:m.files.vmaf,modelSha256:VMAF_MODELS[model].sha256,supervisorSha256:m.files['vmaf-limit'],cliVersion:m.cliVersion,sourceRevision:VMAF_SOURCE_REVISION};
 }catch(error){if(error instanceof VmafError)throw error;throw new VmafError('component-unavailable',`Native component verification failed: ${(error as NodeJS.ErrnoException).code??(error as Error).message}`);}
}
