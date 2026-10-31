import type { FrameDescription } from '../media/frame-description.ts';

export interface YuvLayout {
  bitDepth: number;
  bitShift: number;
  subsampleX: number;
  subsampleY: number;
  semiplanar: boolean;
  chromaLocation: number | null;
  planes: { offset: number; stride: number; width: number; height: number }[];
}

// AVChromaLocation positions in luma pixel coordinates. Unknown uses center;
// never infer chroma siting from the decoder brand or from image content.
export function chromaOffset(l: YuvLayout): [number,number] {
  const n=l.chromaLocation??0;
  return [l.subsampleX?(n>=1&&n<=6?(n%2===0?.5:0):.5):0,
    l.subsampleY?(n===3||n===4?0:n===5||n===6?1:.5):0];
}
export function validateYuv(d: FrameDescription, length: number) {
  const l = d.yuv!;
  if (d.visibleRect.width!==d.width || d.visibleRect.height!==d.height)throw new Error("YUV visible size mismatch");
  if (![8,9,10,12,14,16].includes(l.bitDepth) || !Number.isInteger(l.bitShift) || l.bitShift < 0 || l.bitDepth + l.bitShift > (l.bitDepth === 8 ? 8 : 16)
    || ![0,1,2].includes(l.subsampleX) || ![0,1].includes(l.subsampleY)
    || l.planes.length !== (l.semiplanar ? 2 : 3) || length !== d.byteLength) throw new Error('Invalid YUV layout');
  let end = 0;
  for (const [i,p] of l.planes.entries()) {
    const width = Math.ceil(d.codedWidth / (i ? 2 ** l.subsampleX : 1));
    const height = Math.ceil(d.codedHeight / (i ? 2 ** l.subsampleY : 1));
    const row = width * (l.bitDepth > 8 ? 2 : 1) * (i && l.semiplanar ? 2 : 1);
    const last = p.offset + (height - 1) * p.stride + row;
    if (![p.offset,p.stride,p.width,p.height,last].every(Number.isSafeInteger) || p.offset < end || p.stride < row || p.width !== width || p.height !== height || last > length) throw new Error('YUV plane exceeds owned buffer');
    end = last;
  }
}

export function yuvSample(pixels: Uint8Array | Uint8ClampedArray, l: YuvLayout, component: number, x: number, y: number) {
  const p = l.planes[l.semiplanar && component ? 1 : component];
  const bytes = l.bitDepth > 8 ? 2 : 1;
  if (component) { x = Math.floor(x / 2 ** l.subsampleX); y = Math.floor(y / 2 ** l.subsampleY); }
  const offset = p.offset + y * p.stride + x * bytes * (l.semiplanar && component ? 2 : 1) + (l.semiplanar && component === 2 ? bytes : 0);
  return ((pixels[offset] + (bytes === 2 ? pixels[offset + 1] * 256 : 0)) >>> l.bitShift) & (2 ** l.bitDepth - 1);
}
/** Chroma cells intersecting the visible luma crop; coded padding is not image data. */
export function visibleChromaBounds(d: FrameDescription): [number,number,number,number] {
  const l=d.yuv!,r=d.visibleRect,sx=2**l.subsampleX,sy=2**l.subsampleY;
  return [Math.floor(r.x/sx),Math.floor(r.y/sy),Math.ceil((r.x+r.width)/sx)-1,Math.ceil((r.y+r.height)/sy)-1];
}
export function yuvReconstructedSample(pixels: Uint8Array | Uint8ClampedArray,l:YuvLayout,c:number,x:number,y:number,bounds?:[number,number,number,number]) {
  if(!c)return yuvSample(pixels,l,c,x,y);
  const [ox,oy]=chromaOffset(l),sx=2**l.subsampleX,sy=2**l.subsampleY;
  const px=(x-ox)/sx,py=(y-oy)/sy,bx=Math.floor(px),by=Math.floor(py),wx=px-bx,wy=py-by;
  const plane=l.planes[l.semiplanar?1:c];
  const at=(i:number,j:number)=>yuvSample(pixels,l,c,Math.max(bounds?.[0]??0,Math.min(bounds?.[2]??plane.width-1,i))*sx,Math.max(bounds?.[1]??0,Math.min(bounds?.[3]??plane.height-1,j))*sy);
  return (at(bx,by)*(1-wx)+at(bx+1,by)*wx)*(1-wy)+(at(bx,by+1)*(1-wx)+at(bx+1,by+1)*wx)*wy;
}
