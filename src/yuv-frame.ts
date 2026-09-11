import { keepNativeGpuResource } from './webgpu-presenter.ts';
import type { DecodedFrame } from './media.ts';
import { resolveYuvColor, validateYuv } from './yuv-color.ts';

/** One recycled CPU buffer per source; never shares bytes with a live frame. */
export function createYuvBufferPool(){
  let spare:ArrayBuffer|undefined,disposed=false;
  return {take(size:number){const result=spare?.byteLength===size?spare:new ArrayBuffer(size);spare=undefined;return result;},
    release(buffer:ArrayBuffer){if(!disposed && buffer.byteLength<=64*1024*1024)spare=buffer;},
    dispose(){disposed=true;spare=undefined;}};
}
/** Read the resource's existing planes, never request an RGB conversion or
 * switch decoder. Async work stays inside the media source's backpressure. */
export async function prepareYuvFrame(frame: DecodedFrame, pool?:ReturnType<typeof createYuvBufferPool>, preserveNativeSample=false): Promise<DecodedFrame> {
  if(keepNativeGpuResource())return frame;
  if(frame.kind!=='video-sample' || !frame.sample) return frame;
  const d=frame.description;
  const fallback=(reason:string) => { d.colorFallback=reason; return frame; };
  if(!resolveYuvColor(d).supported)return fallback('browser-managed-color');
  const format=d.format;
  const match=format?.match(/^I(420|422|444)(P10|P12)?$/);
  if(!match && format!=='NV12')return fallback(format===null?'opaque-resource':'unreadable-yuv-format');
  const start=performance.now();
  let resource: VideoFrame | undefined;
  try {
    resource=frame.sample.toVideoFrame();
    const bitDepth=match?.[2]==='P10'?10:match?.[2]==='P12'?12:8;
    const subsampleX=match?.[1]==='444'?0:1, subsampleY=match && match[1]!=='420'?0:1;
    // Copy the full coded rectangle so returned plane offsets remain independent
    // of visibleRect alignment. Apply the crop only during presentation.
    const rect={x:0,y:0,width:resource.codedWidth,height:resource.codedHeight};
    const size=resource.allocationSize({rect});
    const pixels=new Uint8ClampedArray(pool?pool.take(size):new ArrayBuffer(size));
    const layout=await resource.copyTo(pixels,{rect});
    const description={...d,byteLength:pixels.byteLength,byteLengthEstimated:false,
      yuv:{bitDepth,bitShift:0,subsampleX,subsampleY,semiplanar:format==='NV12',chromaLocation:null,
        planes:layout.map((p,i)=>({...p,width:Math.ceil(d.codedWidth/(i?2**subsampleX:1)),height:Math.ceil(d.codedHeight/(i?2**subsampleY:1))}))}};
    validateYuv(description,pixels.byteLength);
    resource.close();resource=undefined;
    const rotation=frame.sample.rotation;
    if(!preserveNativeSample)frame.close();
    let closed=false;
    return {...frame,rotation,sample:preserveNativeSample?frame.sample:undefined,kind:'yuv',description,pixels,copyMs:performance.now()-start,byteSize:(preserveNativeSample?frame.byteSize:0)+pixels.byteLength,close(){if(closed)return;closed=true;if(preserveNativeSample)frame.close();pool?.release(pixels.buffer);}};
  } catch(error) {
    if(error instanceof Error && error.name==='NotSupportedError')return fallback('copyTo-not-supported');
    frame.close(); throw error;
  } finally {resource?.close();}
}
