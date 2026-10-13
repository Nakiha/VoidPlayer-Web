import { MediaOpenError } from './media-errors.ts';
import { ffmpegColorInfo } from './media-metadata.ts';
import { rgbaDescription, validateDescription } from './frame-description.ts';
import type { FrameDescription } from './frame-description.ts';
export type WasmFrameOutput = { pts: number; duration: number; description: FrameDescription; pixels: ArrayBuffer; picture?: {au: number; stream: string; configuration: number} };
export function requireFrameAbi(core: any): void {
  if (typeof core._vp_frame_info!=='function' || typeof core._vp_frame_format!=='function') throw new MediaOpenError('decode','WASM core 缺少完整帧描述接口，请同步当前锁定版本。');
}
/** Copy descriptor and exactly its valid pixels before any further decode call. */
export function readWasmFrame(core: any, heap: () => Uint8Array, ctx: number, recycle?: ArrayBuffer): WasmFrameOutput {
  const ptr=core.ccall('vp_frame_info','number',['number'],[ctx]);
  const memory=heap();
  if (!Number.isSafeInteger(ptr)||ptr<=0||ptr+160>memory.byteLength) throw new MediaOpenError('decode','WASM 帧描述指针越界。');
  const view=new DataView(memory.buffer,ptr,160);
  if (view.getUint32(16,true)!==2||view.getUint32(20,true)!==160) throw new MediaOpenError('decode','WASM 帧描述版本不兼容。');
  const pts=Number(view.getBigInt64(0,true)),duration=Number(view.getBigInt64(8,true));
  if(!Number.isSafeInteger(pts)||!Number.isSafeInteger(duration))throw new MediaOpenError('decode','WASM 输出帧时间戳超出安全范围。');
  const width=view.getInt32(24,true),height=view.getInt32(28,true);
  const sarNum=view.getInt32(60,true),sarDen=view.getInt32(64,true);
  if(sarNum<=0||sarDen<=0)throw new MediaOpenError('decode','WASM 输出像素宽高比无效。');
  const sourceColor=ffmpegColorInfo({colorPrimaries:view.getInt32(44,true),colorTransfer:view.getInt32(48,true),colorSpace:view.getInt32(52,true),colorRange:view.getInt32(56,true)});
  const description=rgbaDescription(width,height,{revision:view.getUint32(68,true),stride:view.getInt32(32,true),byteLength:view.getInt32(36,true),
    displayWidth:Math.max(1,Math.round(width*sarNum/sarDen)),sourceColor,color:{...sourceColor,matrix:'rgb',fullRange:true},
    sourcePixelFormat:null});
  const layout=view.getInt32(72,true);
  const storageBytes=description.byteLength, storageStride=description.stride!;
  if(layout===0)validateDescription(description,storageBytes);
  const x=view.getInt32(144,true),y=view.getInt32(148,true);
  description.width=width-x-view.getInt32(152,true); description.height=height-y-view.getInt32(156,true);
  description.visibleRect={x,y,width:description.width,height:description.height};
  description.displayWidth=Math.max(1,Math.round(description.width*sarNum/sarDen)); description.displayHeight=description.height;
  if(layout!==0) {
    if(layout!==1 && layout!==2)throw new MediaOpenError('decode','Unknown WASM plane layout');
    description.format='YUV'; description.stride=null; description.color=sourceColor;
    description.yuv={bitDepth:view.getInt32(76,true),bitShift:view.getInt32(80,true),
      subsampleX:view.getInt32(84,true),subsampleY:view.getInt32(88,true),chromaLocation:view.getInt32(92,true),semiplanar:layout===2,
      planes:Array.from({length:layout===2?2:3},(_,i)=>({offset:view.getInt32(96+i*16,true),stride:view.getInt32(100+i*16,true),width:view.getInt32(104+i*16,true),height:view.getInt32(108+i*16,true)}))};
  } else {
    description.colorFallback='swscale-rgba';
    description.stride=description.width*4; description.byteLength=description.stride*description.height;
  }
  description.sourcePixelFormat=core.ccall('vp_frame_format','string',['number'],[ctx])||null;
  validateDescription(description,description.byteLength);
  const pixelPtr=core.ccall('vp_pixels','number',['number'],[ctx]),len=description.byteLength;
  const pixels=heap(); // ccall(string) can grow memory; refresh the view.
  if(!Number.isSafeInteger(pixelPtr)||pixelPtr<=0||pixelPtr+storageBytes>pixels.byteLength)throw new MediaOpenError('decode','WASM 输出像素范围越界。');
  const out=recycle?.byteLength===len?new Uint8Array(recycle):new Uint8Array(len);
  if(layout===0 && (x||y||description.width!==width||description.height!==height)) {
    for(let row=0;row<description.height;row++) {
      const start=pixelPtr+(y+row)*storageStride+x*4;
      out.set(pixels.subarray(start,start+description.stride!),row*description.stride!);
    }
  } else out.set(pixels.subarray(pixelPtr,pixelPtr+len));
  let picture: WasmFrameOutput['picture'];
  if (typeof core._vp_picture_info === 'function' && typeof core._vp_picture_abi_version === 'function' && core._vp_picture_abi_version() === 1) {
    const id = core._vp_picture_info(ctx);
    if (id) {
      if(!Number.isSafeInteger(id) || id<1 || id+56>heap().byteLength)throw new MediaOpenError('decode','WASM picture identity pointer out of bounds');
      const v = new DataView(heap().buffer,id,56), au=Number(v.getBigUint64(24,true)), stream=v.getInt32(36,true);
      if(v.getUint32(44,true)===1 && v.getUint32(40,true)===1 && Number(v.getBigInt64(0,true))===pts && Number.isSafeInteger(au) && au>=0 && au<2000000 && stream>=0)
        picture={au,stream:`video:${stream}`,configuration:0};
    }
  }
  return {pts,duration,description,pixels:out.buffer,...(picture?{picture}:{})};
}
