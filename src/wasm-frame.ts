import { MediaOpenError } from './media-errors.ts';
import { ffmpegColorInfo } from './media-metadata.ts';
import { rgbaDescription, validateDescription } from './frame-description.ts';
import type { FrameDescription } from './frame-description.ts';
export type WasmFrameOutput = { pts: number; duration: number; description: FrameDescription; pixels: ArrayBuffer };
export function requireFrameAbi(core: any): void {
  if (typeof core._vp_frame_info!=='function' || typeof core._vp_frame_format!=='function') throw new MediaOpenError('decode','WASM core 缺少完整帧描述接口，请同步当前锁定版本。');
}
/** Copy descriptor and exactly its valid pixels before any further decode call. */
export function readWasmFrame(core: any, heap: () => Uint8Array, ctx: number, recycle?: ArrayBuffer): WasmFrameOutput {
  const ptr=core.ccall('vp_frame_info','number',['number'],[ctx]);
  const memory=heap();
  if (!Number.isSafeInteger(ptr)||ptr<=0||ptr+72>memory.byteLength) throw new MediaOpenError('decode','WASM 帧描述指针越界。');
  const view=new DataView(memory.buffer,ptr,72);
  if (view.getUint32(16,true)!==1||view.getUint32(20,true)!==72) throw new MediaOpenError('decode','WASM 帧描述版本不兼容。');
  const pts=Number(view.getBigInt64(0,true)),duration=Number(view.getBigInt64(8,true));
  if(!Number.isSafeInteger(pts)||!Number.isSafeInteger(duration))throw new MediaOpenError('decode','WASM 输出帧时间戳超出安全范围。');
  const width=view.getInt32(24,true),height=view.getInt32(28,true);
  const sarNum=view.getInt32(60,true),sarDen=view.getInt32(64,true);
  if(sarNum<=0||sarDen<=0)throw new MediaOpenError('decode','WASM 输出像素宽高比无效。');
  const sourceColor=ffmpegColorInfo({colorPrimaries:view.getInt32(44,true),colorTransfer:view.getInt32(48,true),colorSpace:view.getInt32(52,true),colorRange:view.getInt32(56,true)});
  const description=rgbaDescription(width,height,{revision:view.getUint32(68,true),stride:view.getInt32(32,true),byteLength:view.getInt32(36,true),
    displayWidth:Math.max(1,Math.round(width*sarNum/sarDen)),sourceColor,color:{...sourceColor,matrix:'rgb',fullRange:true},
    sourcePixelFormat:core.ccall('vp_frame_format','string',['number'],[ctx])||null});
  validateDescription(description,description.byteLength);
  const pixelPtr=core.ccall('vp_pixels','number',['number'],[ctx]),len=description.byteLength;
  const pixels=heap(); // ccall(string) can grow memory; refresh the view.
  if(!Number.isSafeInteger(pixelPtr)||pixelPtr<=0||pixelPtr+len>pixels.byteLength)throw new MediaOpenError('decode','WASM 输出像素范围越界。');
  const out=recycle?.byteLength===len?new Uint8Array(recycle):new Uint8Array(len);
  out.set(pixels.subarray(pixelPtr,pixelPtr+len));
  return {pts,duration,description,pixels:out.buffer};
}
