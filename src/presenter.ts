import { yuvToRgba } from './yuv-color.ts';
import { validateDescription } from './frame-description.ts';
import { presentationColor } from './presentation-color.ts';
import { createPresentationSurface } from './presentation-surface.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import type { DecodedFrame } from './media.ts';
import { log } from './log.ts';

// Presentation is the only place that decides HOW a decoded frame reaches the
// canvas. Backends deliver timestamps plus a resource (WebCodecs sample or
// RGBA8 pixels); they never paint. Native HDR is converted by the browser's
// sRGB Canvas 2D path before upload, consistently from the first frame onward.
const performanceSamples = new WeakMap<HTMLCanvasElement, { copy: number[]; submit: number[]; count: number }>();
export function paintFrame(canvas: HTMLCanvasElement, frame: DecodedFrame) {
  const start=performance.now();
  paintFrameContent(canvas,frame);
  if(frame.kind!=='yuv')canvas.dataset.colorExecutor=frame.kind==='rgba8'?'rgba-upload':'browser-managed';
  const state=performanceSamples.get(canvas)??{copy:[],submit:[],count:0};
  const index=state.count++%256;
  state.copy[index]=frame.copyMs??0;state.submit[index]=performance.now()-start;performanceSamples.set(canvas,state);
  if(state.count%32===1)canvas.dataset.colorPerformance=JSON.stringify(presentationPerformance(canvas));
}
/** Bounded CPU submission timings, not GPU completion or physical scanout. */
export function presentationPerformance(canvas:HTMLCanvasElement) {
  const state=performanceSamples.get(canvas);if(!state)return null;
  const summary=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};};
  return {count:state.count,window:state.copy.length,copyMs:summary(state.copy),submitMs:summary(state.submit)};
}

const colorStates = new WeakMap<HTMLCanvasElement, string>();
function paintFrameContent(canvas: HTMLCanvasElement, frame: DecodedFrame) {
  validateDescription(frame.description,frame.pixels?.byteLength);
  if(frame.kind==='yuv') {
    const d=frame.description, rotation=frame.rotation??frame.sample?.rotation??0;
    const width=rotation===90||rotation===270?d.height:d.width;
    const height=rotation===90||rotation===270?d.width:d.height;
    if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
  }
  if (frame.kind!=='yuv' && canvas.width !== frame.width) canvas.width = frame.width;
  if (frame.kind!=='yuv' && canvas.height !== frame.height) canvas.height = frame.height;
  const surface = surfaces.get(canvas);
  const policy = presentationColor(frame.kind, frame.description);
  const colorState = JSON.stringify({ kind: frame.kind, ...policy });
  if (colorStates.get(canvas) !== colorState) {
    colorStates.set(canvas, colorState);
    log.info('media', '上屏色彩路径', { canvas: canvas.id, kind: frame.kind, ...policy, sourcePtsUs: frame.sourcePtsUs });
    if (policy.unsupportedHdr) log.warn('media', '软件 RGBA8 输出未完成 HDR 到 SDR 的色彩转换，当前画面不适合色彩评审。', { canvas: canvas.id, ...policy });
  }
  if(frame.kind==='yuv') {
    if(!frame.pixels)throw new Error('YUV 帧缺少像素数据。');
    const rotation=frame.rotation??frame.sample?.rotation??0;
    if(surface?.uploadYuv(frame.description,frame.pixels,rotation)){canvas.dataset.colorExecutor='webgl-yuv';return;}
    canvas.dataset.colorExecutor='cpu-yuv';
    const pixels=yuvToRgba(frame.description,frame.pixels);
    const ctx=canvas.getContext('2d',{colorSpace:'srgb'});if(!ctx)throw new Error('浏览器无法创建画布。');
    const image=new ImageData(pixels,frame.description.width,frame.description.height);
    if(rotation){
      const scratch=new OffscreenCanvas(image.width,image.height);scratch.getContext('2d')!.putImageData(image,0,0);
      ctx.save();ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(scratch,-image.width/2,-image.height/2);ctx.restore();
    }else ctx.putImageData(image,0,0);
    surface?.upload();return;
  }
  if (surface?.directUpload) {
    if (frame.kind === 'rgba8') {
      if (!frame.pixels) throw new Error('RGBA 帧缺少像素数据。');
      surface.upload(frame.pixels);
      return;
    }
    if (!frame.sample) throw new Error('视频帧缺少采样内容。');
    if (frame.sample.rotation === 0 && !policy.canvasConversion) {
      const resource = frame.sample.toVideoFrame();
      try { surface.upload(resource); } finally { resource.close(); }
      return;
    }
  }
  // Direct VideoFrame -> WebGL and drawImage -> sRGB canvas do not have the
  // same HDR conversion on every browser. Use drawImage for ALL PQ/HLG frames,
  // including clones, seeks and playback. Never relabel already-converted pixels
  // with container HDR metadata. SDR retains direct upload; no CPU readback.
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!ctx) throw new Error('浏览器无法创建画布。');
  if (frame.kind === 'rgba8') {
    if (!frame.pixels) throw new Error('RGBA 帧缺少像素数据。');
    ctx.putImageData(new ImageData(frame.pixels as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height), 0, 0);
    surface?.upload();
    return;
  }
  if (!frame.sample) throw new Error('视频帧缺少采样内容。');
  frame.sample.draw(ctx, 0, 0, canvas.width, canvas.height);
  surface?.upload();
}

/** Materialize source-sized pixels on demand; playback never calls this. */
export function captureFrame(canvas: HTMLCanvasElement) { return surfaces.get(canvas)?.captureSource() ?? canvas; }

const surfaces = new Map<HTMLCanvasElement, NonNullable<ReturnType<typeof createPresentationSurface>>>();
export function setPresentationGeometry(canvas: HTMLCanvasElement, geometry: PresentationGeometry | null) {
  if (!geometry) {
    if (surfaces.has(canvas)) { surfaces.get(canvas)!.dispose(); surfaces.delete(canvas); canvas.width = canvas.height = 1; }
    return;
  }
  if (!surfaces.has(canvas) && geometry) { const surface = createPresentationSurface(canvas); if (surface) surfaces.set(canvas, surface); }
  surfaces.get(canvas)?.geometry(geometry);
}
export function disposePresentation() { for (const surface of surfaces.values()) surface.dispose(); surfaces.clear(); }
