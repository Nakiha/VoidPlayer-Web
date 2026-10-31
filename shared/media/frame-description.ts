import { validateYuv } from '../color/yuv-planes.ts';
import type { YuvLayout } from '../color/yuv-planes.ts';
import type { ColorInfo } from '../review/model.ts';
import { MediaOpenError } from './io/media-errors.ts';
export type FrameDescription = {
  yuv?: YuvLayout;
  colorFallback?: string;
  revision: number;
  /** Pixel geometry and presentation geometry are separate (crop/SAR/rotation). */
  width: number; height: number;
  codedWidth: number; codedHeight: number;
  visibleRect: { x: number; y: number; width: number; height: number };
  displayWidth: number; displayHeight: number;
  stride: number | null; byteLength: number;
  /** True when byteLength is only a queue-budget estimate, not readable storage. */
  byteLengthEstimated?: boolean;
  format: string | null;
  color: ColorInfo;
  sourcePixelFormat?: string | null;
  sourceColor?: ColorInfo;
  /** Provenance of encoded tags, independent of the delivered resource color. */
  sourceColorOrigin?: 'container' | 'decoder';
};
export const unknownColor = (): ColorInfo => ({ primaries:null, transfer:null, matrix:null, fullRange:null });
export function rgbaDescription(width: number, height: number, overrides: Partial<FrameDescription> = {}): FrameDescription {
  return { revision:1,width,height,codedWidth:width,codedHeight:height,visibleRect:{x:0,y:0,width,height},displayWidth:width,displayHeight:height,
    stride:width*4,byteLength:width*height*4,format:'RGBA',color:unknownColor(),...overrides };
}
export function validateDescription(d: FrameDescription, rgbaBytes?: number): void {
  const positive=[d.width,d.height,d.codedWidth,d.codedHeight,d.displayWidth,d.displayHeight,d.revision];
  if (positive.some(n=>!Number.isSafeInteger(n)||n<=0) || !Number.isSafeInteger(d.byteLength) || d.byteLength<0) throw new MediaOpenError('decode','解码帧描述包含无效的尺寸或长度。');
  const r=d.visibleRect;
  if (![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>d.codedWidth||r.y+r.height>d.codedHeight) throw new MediaOpenError('decode','解码帧裁剪区域越界。');
  if (d.yuv) { validateYuv(d, rgbaBytes ?? d.byteLength); return; }
  if (rgbaBytes!==undefined && (d.format!=='RGBA'||d.stride!==d.width*4||d.byteLength!==d.stride*d.height||rgbaBytes!==d.byteLength)) throw new MediaOpenError('decode','RGBA 像素长度、行跨度与实际输出尺寸不一致。');
}
