import { containerFromHeader } from '../../shared/media/containers/container-header.ts';
import { VIDEO_EXTENSIONS } from '../../shared/media/containers/video-files.ts';
import { msg, t } from '../i18n.ts';

type Rejection = 'image' | 'audio' | 'app' | 'disk' | 'folder' | 'unsupported' | 'unreadable';
type Rejected = {name:string; kind:Rejection};
type NonFile = {directory:string} | {unreadable:string};
export type LocalItem<T> = {file:File; handle?:T} | NonFile;
export class LocalInputError extends Error {}

export function nonVideoMime(type: string): Rejection | undefined {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'inode/directory' || type === 'application/x-directory') return 'folder';
  if (type === 'application/x-apple-diskimage') return 'disk';
}

async function fileKind(file: File): Promise<Rejection | undefined> {
  const ext = /\.[^./]+$/.exec(file.name.toLowerCase())?.[0] ?? '';
  if (ext === '.app') return 'app';
  if (ext === '.dmg' || ext === '.iso') return 'disk';
  const mime = nonVideoMime(file.type);
  if (mime) return mime;
  if (/^\.(png|jpe?g|gif|bmp|webp|tiff?|heic|heif|avif|svg|ico)$/.test(ext)) return 'image';
  if (/^\.(mp3|wav|flac|aac|m4a|aiff?|opus|oga)$/.test(ext)) return 'audio';
  // Keep extensionless and misnamed videos usable without probing them with a decoder.
  try {
    const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const tag = (at:number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (tag(0) === '\x89PNG' || bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ||
        tag(0).startsWith('GIF8') || tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image';
    if (tag(4) === 'ftyp') {
      if (/^(hei[cfsx]|hev[cx]|mif1|msf1|avif|avis)$/.test(tag(8))) return 'image';
      if (tag(8) === 'M4A ' || tag(8) === 'M4B ') return 'audio';
    }
    if (tag(0) === 'fLaC' || tag(0) === 'RIFF' && tag(8) === 'WAVE') return 'audio';
    if (containerFromHeader(bytes) !== 'other') return;
    if (tag(0) === 'RIFF' && tag(8) === 'AVI ') return;
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba) return;
    // Recognized names still get the normal damaged-video diagnostics.
    if (VIDEO_EXTENSIONS.includes(ext) && !file.type.startsWith('text/')) return;
    return 'unsupported';
  } catch { return 'unreadable'; }
}

function rejectionMessage(rejected: Rejected[]) {
  const {kind, name} = rejected[0];
  if (rejected.length > 1) return t(msg('input.skippedFiles', '已跳过 {count} 个无法作为视频打开的项目（包括「{name}」）。请选择视频文件。'), {count:rejected.length, name});
  switch (kind) {
    case 'folder': return t(msg('input.folder', '「{name}」是文件夹。请打开文件夹，选择其中的视频文件。'), {name});
    case 'app': return t(msg('input.app', '「{name}」是应用程序。请选择视频文件。'), {name});
    case 'disk': return t(msg('input.disk', '「{name}」是磁盘映像。请选择视频文件。'), {name});
    case 'image': return t(msg('input.image', '「{name}」是图片。请选择视频文件。'), {name});
    case 'audio': return t(msg('input.audio', '「{name}」是音频文件。请选择含视频轨道的文件。'), {name});
    case 'unreadable': return t(msg('input.unreadable', '无法读取「{name}」。请重新选择可访问的视频文件。'), {name});
    default: return t(msg('input.unsupported', '无法将「{name}」作为视频打开。请选择支持的视频文件，例如 MP4、MOV 或 MKV。'), {name});
  }
}

export async function selectVideoInputs<T extends {file:File}>(items: (T | NonFile)[], report: (error: LocalInputError) => void) {
  const accepted: T[] = [], rejected: Rejected[] = [];
  for (const item of items) {
    if ('directory' in item) {
      rejected.push({name:item.directory, kind:/\.app$/i.test(item.directory) ? 'app' : 'folder'});
    } else if ('unreadable' in item) {
      rejected.push({name:item.unreadable, kind:'unreadable'});
    } else {
      const kind = await fileKind(item.file);
      if (kind) rejected.push({name:item.file.name, kind}); else accepted.push(item);
    }
  }
  if (rejected.length) report(new LocalInputError(rejectionMessage(rejected)));
  return accepted;
}
