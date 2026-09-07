import type {MediaInfo} from './model.ts';
import type {MediaSource,DecodedFrame} from './media.ts';
import {contextLog} from './log.ts';
export type MediaInfoChange={revision:number;reason:'index'|'presented-frame'|'identity';changed:string[];before:MediaInfo;after:MediaInfo};
const equal=(a:unknown,b:unknown)=>a===b||(typeof a==='object'&&typeof b==='object'&&JSON.stringify(a)===JSON.stringify(b));
/** Single update boundary for source metadata. Stable info identity preserves
 * catalog references; events carry detached snapshots of exactly this change. */
export function updateMediaInfo(source:Pick<MediaSource,'info'|'onInfoChange'>,patch:Partial<MediaInfo>,reason:MediaInfoChange['reason'],notify=true):boolean{
  const changed=Object.keys(patch).filter(key=>key!=='metadataRevision'&&!equal(source.info[key as keyof MediaInfo],patch[key as keyof MediaInfo]));
  if(!changed.length)return false;
  const before=structuredClone(source.info);
  for(const key of changed)Object.assign(source.info,{[key]:structuredClone(patch[key as keyof MediaInfo])});
  source.info.metadataRevision=(source.info.metadataRevision??0)+1;
  const change:MediaInfoChange={revision:source.info.metadataRevision,reason,changed,before,after:structuredClone(source.info)};
  contextLog().info('media','元数据变更',{mediaId:source.info.id,revision:change.revision,reason,changed,values:Object.fromEntries(changed.map(key=>[key,change.after[key as keyof MediaInfo]]))});
  if(notify)source.onInfoChange?.(change);
  return true;
}
/** Called only by session when a frame is actually presented, never by prefetch. */
export function recordPresentedFrame(source:MediaSource,frame:DecodedFrame):boolean{
  const d=frame.description;
  return updateMediaInfo(source,{width:frame.width,height:frame.height,output:d,decodedPixelFormat:d.format,
    ...(d.sourcePixelFormat!==undefined?{pixelFormat:d.sourcePixelFormat}:{}),
    ...(d.sourceColor?{color:d.sourceColor,colorSource:'decoder' as const}:{})},'presented-frame',false);
}
