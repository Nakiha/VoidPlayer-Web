import type { ColorInfo } from './model.ts';
import type { VideoSample } from 'mediabunny';
import { MediaOpenError } from './media-errors.ts';
export type FrameDescription = {
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
};
export const unknownColor = (): ColorInfo => ({ primaries:null, transfer:null, matrix:null, fullRange:null });
export function rgbaDescription(width: number, height: number, overrides: Partial<FrameDescription> = {}): FrameDescription {
  return { revision:1,width,height,codedWidth:width,codedHeight:height,visibleRect:{x:0,y:0,width,height},displayWidth:width,displayHeight:height,
    stride:width*4,byteLength:width*height*4,format:'RGBA',color:unknownColor(),...overrides };
}
/** Describe a borrowed resource without cloning, copying, or closing it.
 * Opaque hardware surfaces remain valid renderable frames. Their storage layout
 * is unavailable, so charge an RGBA16-sized budget estimate using coded pixels.
 * allocationSize is a copy-buffer size, never total decoder/GPU memory usage. */
export function videoFrameDescription(frame: VideoFrame, displayWidth = frame.displayWidth, displayHeight = frame.displayHeight, byteLength?: number): FrameDescription {
  let byteLengthEstimated = false;
  if (byteLength === undefined) {
    if (frame.format === null) byteLengthEstimated = true;
    else {
      try { byteLength = frame.allocationSize(); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== 'NotSupportedError') throw error;
        byteLengthEstimated = true;
      }
    }
    if (byteLengthEstimated) byteLength = frame.codedWidth * frame.codedHeight * 8;
  }
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const color = frame.colorSpace;
  const description: FrameDescription = { revision: 1, width: rect.width, height: rect.height,
    codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
    visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, displayWidth, displayHeight,
    stride: null, byteLength: byteLength!, byteLengthEstimated, format: frame.format,
    color: { primaries: color.primaries, transfer: color.transfer, matrix: color.matrix, fullRange: color.fullRange } };
  validateDescription(description);
  return description;
}
export function sampleDescription(sample: VideoSample, byteLength?: number): FrameDescription {
  const frame = sample.toVideoFrame();
  try { return videoFrameDescription(frame, sample.displayWidth, sample.displayHeight, byteLength); }
  finally { frame.close(); }
}
export function validateDescription(d: FrameDescription, rgbaBytes?: number): void {
  const positive=[d.width,d.height,d.codedWidth,d.codedHeight,d.displayWidth,d.displayHeight,d.revision];
  if (positive.some(n=>!Number.isSafeInteger(n)||n<=0) || !Number.isSafeInteger(d.byteLength) || d.byteLength<0) throw new MediaOpenError('decode','解码帧描述包含无效的尺寸或长度。');
  const r=d.visibleRect;
  if (![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>d.codedWidth||r.y+r.height>d.codedHeight) throw new MediaOpenError('decode','解码帧裁剪区域越界。');
  if (rgbaBytes!==undefined && (d.format!=='RGBA'||d.stride!==d.width*4||d.byteLength!==d.stride*d.height||rgbaBytes!==d.byteLength)) throw new MediaOpenError('decode','RGBA 像素长度、行跨度与实际输出尺寸不一致。');
}
