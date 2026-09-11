import type { ColorInfo } from './model.ts';
import type { FrameDescription } from './frame-description.ts';

export interface YuvLayout {
  bitDepth: number;
  bitShift: number;
  subsampleX: number;
  subsampleY: number;
  semiplanar: boolean;
  chromaLocation: number | null;
  planes: { offset: number; stride: number; width: number; height: number }[];
}

/** Display-referred SDR: preserve nonlinear signal values, with no 709 OETF
 * inversion. This is an explicit sRGB-like viewing convention, not scene-linear
 * colorimetry. Source tags are never mutated by these defaults. */
export function resolveYuvColor(d: FrameDescription) {
  const c = d.color;
  const matrix = c.matrix ?? (d.codedWidth >= 1280 || d.codedHeight > 576 ? 'bt709' : 'smpte170m');
  const fullRange = c.fullRange ?? !!d.sourcePixelFormat?.startsWith('yuvj');
  const primaries = c.primaries ?? (matrix === 'bt2020-ncl' ? 'bt2020' : matrix === 'bt709' ? 'bt709' : 'smpte170m');
  const transfer = c.transfer ?? 'bt709';
  const supported = ['bt709', 'smpte170m', 'bt470bg', 'bt2020-ncl'].includes(matrix)
    && ['bt709', 'smpte170m', 'bt470bg', 'bt2020'].includes(primaries)
    && ['bt709', 'smpte170m', 'iec61966-2-1', 'bt2020-10', 'bt2020-12'].includes(transfer);
  return { matrix, fullRange, primaries, transfer, supported,
    provenance: Object.fromEntries(['matrix','fullRange','primaries','transfer'].map(k => [k, c[k as keyof ColorInfo] == null ? 'fallback' : 'resource'])),
    target: 'srgb', sdrTransfer: 'display-referred-srgb-like', chromaSampling: 'bilinear-sited' };
}
// AVChromaLocation positions in luma pixel coordinates. Unknown uses center;
// never infer chroma siting from the decoder brand or from image content.
export function chromaOffset(l: YuvLayout): [number,number] {
  const n=l.chromaLocation??0;
  return [l.subsampleX?(n>=1&&n<=6?(n%2===0?.5:0):.5):0,
    l.subsampleY?(n===3||n===4?0:n===5||n===6?1:.5):0];
}
export function yuvCoefficients(matrix: string): [number, number] {
  return matrix === 'bt709' ? [0.2126, 0.0722] : matrix === 'bt2020-ncl' ? [0.2627, 0.0593] : [0.299, 0.114];
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
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export function yuvReconstructedSample(pixels: Uint8Array | Uint8ClampedArray,l:YuvLayout,c:number,x:number,y:number) {
  if(!c)return yuvSample(pixels,l,c,x,y);
  const [ox,oy]=chromaOffset(l),sx=2**l.subsampleX,sy=2**l.subsampleY;
  const px=(x-ox)/sx,py=(y-oy)/sy,bx=Math.floor(px),by=Math.floor(py),wx=px-bx,wy=py-by;
  const plane=l.planes[l.semiplanar?1:c];
  const at=(i:number,j:number)=>yuvSample(pixels,l,c,Math.max(0,Math.min(plane.width-1,i))*sx,Math.max(0,Math.min(plane.height-1,j))*sy);
  return (at(bx,by)*(1-wx)+at(bx+1,by)*wx)*(1-wy)+(at(bx,by+1)*(1-wx)+at(bx+1,by+1)*wx)*wy;
}
const encoded = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
/** Single source pixel through the shared range/matrix/transfer plan. */
export function yuvPixelRgb(d: FrameDescription, pixels: Uint8Array | Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const l = d.yuv!, plan = resolveYuvColor(d);
  const [kr, kb] = yuvCoefficients(plan.matrix), kg = 1 - kr - kb;
  const scale = 2 ** (l.bitDepth - 8), max = 2 ** l.bitDepth - 1;
  const sx = x + d.visibleRect.x, sy = y + d.visibleRect.y;
  const yy = (yuvSample(pixels, l, 0, sx, sy) - (plan.fullRange ? 0 : 16 * scale)) / (plan.fullRange ? max : 219 * scale);
  const cb = (yuvReconstructedSample(pixels, l, 1, sx, sy) - 128 * scale) / (plan.fullRange ? max : 224 * scale);
  const cr = (yuvReconstructedSample(pixels, l, 2, sx, sy) - 128 * scale) / (plan.fullRange ? max : 224 * scale);
  let rgb = [yy + 2 * (1 - kr) * cr, yy - 2 * kb * (1 - kb) / kg * cb - 2 * kr * (1 - kr) / kg * cr, yy + 2 * (1 - kb) * cb];
  if (plan.primaries === 'bt2020') {
    const [r, g, b] = rgb.map(v => linear(Math.max(0, v)));
    rgb = [1.660491 * r - 0.587641 * g - 0.072850 * b, -0.124550 * r + 1.132900 * g - 0.008349 * b, -0.018151 * r - 0.100579 * g + 1.118730 * b].map(encoded);
  }
  return [Math.round(Math.max(0, Math.min(1, rgb[0])) * 255), Math.round(Math.max(0, Math.min(1, rgb[1])) * 255), Math.round(Math.max(0, Math.min(1, rgb[2])) * 255)];
}
/** Independent CPU reference and no-WebGL fallback. High depth stays intact
 * through range/matrix arithmetic, quantized only at final RGB output. */
export function yuvToRgba(d: FrameDescription, pixels: Uint8Array | Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  validateYuv(d,pixels.byteLength);
  const l=d.yuv!, plan=resolveYuvColor(d);
  if (!plan.supported) throw new Error('Unsupported YUV color plan');
  const out=new Uint8ClampedArray(d.width*d.height*4);
  for(let y=0;y<d.height;y++) for(let x=0;x<d.width;x++) {
    const [r,g,b]=yuvPixelRgb(d,pixels,x,y);
    const i=(y*d.width+x)*4;
    out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  }
  return out;
}
