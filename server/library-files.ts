import {promises as fs, constants} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {AdminError} from './admin-error.ts';
import {LIBRARY_FILE_BATCH_LIMIT} from '../shared/service/library-files.ts';
import type {LibraryFileCommand,LibraryFileRef,LibraryFileResult} from '../shared/service/library-files.ts';

type Root = {id:string; path:string};
const bad = (message:string) => new AdminError(400,message,'invalid-library-file-command');
function relative(value:unknown, empty=false):string {
  if (typeof value!=='string'||value.length>4096||(!value&&!empty)||/[\\\x00-\x1f:]/.test(value)
    ||value.split('/').some(part => !part||part.startsWith('.')||/[. ]$/.test(part))) {
    if (empty&&value==='') return '';
    throw bad('无效的媒体库相对路径。');
  }
  return value;
}
function reference(value:unknown):LibraryFileRef {
  if (!value||typeof value!=='object') throw bad('缺少文件引用。');
  const ref=value as LibraryFileRef;
  if (typeof ref.rootId!=='string'||!ref.rootId||!['file','directory'].includes(ref.kind)) throw bad('无效的文件引用。');
  relative(ref.path);
  if ((ref.kind==='file'||ref.version!==undefined)&&!(/^[0-9a-f]{24}$/).test(ref.version??'')) throw bad('文件操作需要固定的源版本。');
  return {rootId:ref.rootId,path:ref.path,kind:ref.kind,...(ref.version?{version:ref.version}:{})};
}
export function parseLibraryFileCommand(body:unknown):LibraryFileCommand {
  if (!body||typeof body!=='object') throw bad('无效的文件操作。');
  const value=body as LibraryFileCommand;
  if (value.operation==='rename') {
    const name=relative(value.name);
    if (name.includes('/')) throw bad('新名称不能包含目录。');
    return {operation:'rename',source:reference(value.source),name};
  }
  if (value.operation!=='move'&&value.operation!=='delete') throw bad('未知文件操作。');
  if (!Array.isArray(value.sources)||!value.sources.length||value.sources.length>LIBRARY_FILE_BATCH_LIMIT) throw bad('每次操作需要 1 至 100 个项目。');
  const sources=value.sources.map(reference);
  if (value.operation==='delete') return {operation:'delete',sources};
  if (!value.target||typeof value.target.rootId!=='string'||!value.target.rootId) throw bad('缺少目标媒体库。');
  return {operation:'move',sources,target:{rootId:value.target.rootId,directory:relative(value.target.directory,true)}};
}

/** No symlink traversal, no mount-root mutation, no overwrite or implicit retry.
 * App-owned writes are serialized by MediaLibraryIndex. Other filesystem writers
 * are not locked; verify source identity again immediately before each write. */
export async function mutateLibraryFiles(roots:readonly Root[], command:LibraryFileCommand, version:(stat:Stats)=>string, beforeWrite?:()=>void) {
  const sources=command.operation==='rename'?[command.source]:command.sources;
  const rootPaths=new Map<string,string>();
  const rootPath=async (id:string) => {
    let real=rootPaths.get(id);
    if (!real) {
      const root=roots.find(root => root.id===id);
      if (!root) throw new AdminError(404,'媒体库不存在。');
      real=await fs.realpath(root.path); rootPaths.set(id,real);
    }
    return real;
  };
  const resolve=async (id:string, name:string) => {
    const root=await rootPath(id);
    let absolute=root;
    for (const part of name.split('/').filter(Boolean)) {
      absolute=path.join(absolute,part);
      if ((await fs.lstat(absolute)).isSymbolicLink()) throw new AdminError(409,'文件操作不跟随符号链接。','library-file-symlink');
    }
    return absolute;
  };
  const occupied=async (absolute:string) => {
    try {await fs.lstat(absolute);return true;} catch (error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  };
  const planned=[];
  const destinations=new Set<string>();
  for (const source of sources) {
    const absolute=await resolve(source.rootId,source.path),stat=await fs.lstat(absolute);
    for (const root of roots) {
      const mounted=await fs.realpath(root.path).catch(() => undefined);
      if (mounted&&(mounted===absolute||mounted.startsWith(absolute+path.sep))) throw new AdminError(409,'不能移动、改名或删除已配置的媒体库挂载目录。','library-mount-protected');
    }
    if (source.kind==='file'?!stat.isFile():!stat.isDirectory()) throw new AdminError(409,'文件类型已变化。','library-file-changed');
    if (source.version&&version(stat)!==source.version) throw new AdminError(409,'文件已变化，请刷新目录后重试。','library-file-changed');
    let destination:{rootId:string;path:string}|undefined, target:string|undefined;
    if (command.operation!=='delete') {
      const directory=command.operation==='move'?command.target.directory:path.posix.dirname(source.path).replace(/^\.$/,'');
      const rootId=command.operation==='move'?command.target.rootId:source.rootId;
      const parent=await resolve(rootId,directory);
      const parentStat=await fs.stat(parent);
      if (!parentStat.isDirectory()) throw bad('目标不是目录。');
      if (source.kind==='directory'&&stat.dev!==parentStat.dev) throw new AdminError(409,'跨磁盘移动文件夹暂不支持，原目录已保留。','library-directory-cross-device');
      target=path.join(parent,command.operation==='rename'?command.name:path.basename(absolute));
      const key=process.platform==='win32'?target.toLocaleLowerCase():target;
      if (destinations.has(key)||await occupied(target)) throw new AdminError(409,'目标位置已有同名项目。','library-file-conflict');
      destinations.add(key);
      if (target===absolute||target.startsWith(absolute+path.sep)) throw bad('不能把目录移入自身或子目录。');
      destination={rootId,path:path.relative(await rootPath(rootId),target).split(path.sep).join('/')};
    }
    planned.push({source,absolute,stat,target,destination});
  }
  for (const a of planned) for (const b of planned) if (a!==b&&(a.absolute===b.absolute||b.absolute.startsWith(a.absolute+path.sep))) throw bad('操作列表包含重复项目或父子目录。');
  beforeWrite?.();
  const results:LibraryFileResult['results']=[];
  const relocatedFiles:{source:LibraryFileRef;destination:{rootId:string;path:string};sourceVersion:string;version:string}[]=[];
  for (const item of planned) {
    try {
      const current=await fs.lstat(await resolve(item.source.rootId,item.source.path));
      if (version(current)!==version(item.stat)) throw new AdminError(409,'源项目在操作期间变化。','library-file-changed');
      if (item.target) {
        await resolve(item.destination!.rootId,path.posix.dirname(item.destination!.path).replace(/^\.$/,''));
        if (await occupied(item.target)) throw new AdminError(409,'目标位置已有同名项目。','library-file-conflict');
        if (item.source.kind==='file') {
          // link is exclusive; cross-volume files use an exclusive copy instead.
          try {await fs.link(item.absolute,item.target);} catch (error) {
            if (!['EXDEV','ENOTSUP','EPERM'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
            await fs.copyFile(item.absolute,item.target,constants.COPYFILE_EXCL);
          }
          const after=await fs.lstat(item.absolute);
          if (after.ino!==current.ino||after.dev!==current.dev||after.size!==current.size||after.mtimeMs!==current.mtimeMs) {
            throw new AdminError(409,'源文件在移动期间变化，保留两端文件。','library-file-changed');
          }
          const copied=await fs.lstat(item.target);
          await fs.unlink(item.absolute);
          // The link/unlink changes ctime; a copy has a new inode as well. Only
          // this operation's final destination version can inherit display data.
          const destination=await fs.lstat(item.target).catch(() => undefined);
          if (destination?.isFile()&&destination.size===current.size&&destination.ino===copied.ino
            &&destination.dev===copied.dev&&destination.mtimeMs===copied.mtimeMs) {
            relocatedFiles.push({source:item.source,destination:item.destination!,sourceVersion:version(current),version:version(destination)});
          }
        } else await fs.rename(item.absolute,item.target);
      } else if (item.source.kind==='directory') await fs.rm(item.absolute,{recursive:true});
      else await fs.unlink(item.absolute);
      results.push({source:item.source,...(item.destination?{destination:item.destination}:{}),ok:true});
    } catch (error) {
      const code=(error as NodeJS.ErrnoException).code;
      results.push({source:item.source,...(item.destination?{destination:item.destination}:{}),ok:false,error:code==='EXDEV'?'跨磁盘移动文件夹暂不支持，原目录已保留。':(error as Error).message});
    }
  }
  const scopes=planned.flatMap(item => [{rootId:item.source.rootId,directory:path.posix.dirname(item.source.path).replace(/^\.$/,'')},
    ...(item.destination?[{rootId:item.destination.rootId,directory:path.posix.dirname(item.destination.path).replace(/^\.$/,'')}]:[])]);
  return {results,scopes,relocatedFiles};
}
