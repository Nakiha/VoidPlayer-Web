import { log } from './log.ts';
import { getColorMode } from './color-mode.ts';
import { detectGpuProfile } from './webgpu-calibration.ts';
import { createExternalSurface } from './webgpu-color-surface.mjs';
import type { GpuSurface } from './webgpu-color-surface.mjs';
import type { DecodedFrame } from './media.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import { resolveYuvColor } from './yuv-color.ts';
import { validateDescription } from './frame-description.ts';

// Browser compensation is diagnostic-only: a neutral decoded probe cannot
// certify other codecs, backing resources, or color tags.
export function requestedGpuMode() {
  const mode=typeof location==='undefined'?null:new URLSearchParams(location.search).get('colorPipeline');
  return mode==='webgpu-apple709'?'hybrid':mode==='webgpu-cv-full-range'?'webkit-planes':null;
}
let active=false;
let unified=false;
let experimentalProfile=false;
// The explicit common-plane path keeps hardware decoding but reads the native
// resource's own planes before queuing, using the same shader as software YUV.
// External textures are browser-managed and are not a reference for this mode.
export const keepNativeGpuResource=()=>active&&!unified;
const entries=new Map<HTMLCanvasElement,{canvas:HTMLCanvasElement;surface:GpuSurface;geometry:PresentationGeometry|null;disabled:boolean}>();
export async function initializeGpuPresentation(sources:HTMLCanvasElement[]) {
  if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('colorPipeline')==='legacy')return;
  const commonPlanes=typeof location!=='undefined'&&new URLSearchParams(location.search).get('colorPipeline')==='unified';
  const policy=getColorMode();
  const requested=policy==='reference'?null:policy==='browser'?await detectGpuProfile():commonPlanes?null:requestedGpuMode();
  const mode=requested??'planes';
  let device:unknown;
  try{
    for(const source of sources){
      const canvas=document.createElement('canvas');canvas.className='frame-presentation';canvas.hidden=true;
      source.closest('.frame-stage')!.prepend(canvas);
      try{const surface=await createExternalSurface(canvas,device,mode);device=surface.device;entries.set(source,{canvas,surface,geometry:null,disabled:false});}
      catch(error){canvas.remove();throw error;}
    }
    active=true;
    unified=commonPlanes;
    experimentalProfile=requested!==null;
    log.info('media','WebGPU 色彩路径已启用。',{profile:mode,selection:commonPlanes?'explicit-common-planes':requested?'explicit-experiment':'resource-contract',nativeContract:'browser-managed',yuvContract:requested?'experimental-profile':'common-yuv-sdr'});
  }catch(error){disposeGpuPresentation();log.info('media','WebGPU 初始化失败，保留现有呈现路径。',{reason:String(error)});}
}
export async function refreshGpuColorMode(){
  const saved=[...entries].map(([source,entry])=>({source,geometry:entry.geometry}));
  disposeGpuPresentation();await initializeGpuPresentation(saved.map(e=>e.source));
  saved.forEach(({source,geometry})=>gpuGeometry(source,geometry));
}
export function gpuGeometry(source:HTMLCanvasElement,g:PresentationGeometry|null){
  const entry=entries.get(source);if(!entry)return false;
  entry.geometry=g;if(entry.disabled){if(!g){entry.disabled=false;entry.surface.clear();}return false;}
  entry.canvas.hidden=!g;
  source.classList.toggle('frame-source',!!g);
  if(!g)entry.surface.clear();
  entry.surface.setGeometry(g);return true;
}
const timings=new WeakMap<HTMLCanvasElement,{values:number[];count:number}>();
export function gpuPaint(source:HTMLCanvasElement,frame:DecodedFrame){
  const start=performance.now();
  const entry=entries.get(source);if(!entry)return false;
  if(entry.disabled)return false;
  validateDescription(frame.description,frame.kind==='yuv'?frame.pixels?.byteLength:undefined);
  if(!entry.surface.available||(frame.kind==='yuv'&&!resolveYuvColor(frame.description).supported)||frame.kind==='rgba8'||['smpte2084','arib-std-b67'].includes(frame.description.color.transfer??'')){
    entry.disabled=true;entry.canvas.hidden=true;entry.surface.clear();source.classList.remove('frame-source');
    log.info('media','当前资源使用现有呈现路径。',{kind:frame.kind,transfer:frame.description.color.transfer,gpuAvailable:entry.surface.available});return false;
  }
  const rotation=frame.rotation??frame.sample?.rotation??0;
  const d=frame.description,swap=rotation===90||rotation===270;
  const width=swap?d.height:d.width,height=swap?d.width:d.height;
  if(source.width!==width)source.width=width;if(source.height!==height)source.height=height;
  entry.surface.setGeometry(entry.geometry,rotation);
  const resource=frame.kind==='yuv'?null:frame.sample!.toVideoFrame();
  try{entry.surface.present(resource??frame);}
  catch(error){entry.disabled=true;entry.canvas.hidden=true;entry.surface.clear();source.classList.remove('frame-source');log.info('media','WebGPU 资源呈现失败，使用现有呈现路径。',{reason:String(error)});return false;}
  finally{resource?.close();}
  source.dataset.colorExecutor=frame.kind==='yuv'?'webgpu-yuv':'webgpu-external';
  source.dataset.colorContract=frame.kind==='yuv'?(experimentalProfile?'profile-yuv-sdr':'common-yuv-sdr'):'browser-managed';
  const timing=timings.get(source)??{values:[],count:0},values=timing.values;values.push(performance.now()-start);if(values.length>128)values.shift();timing.count++;timings.set(source,timing);
  if(timing.count%32===0){const sorted=[...values].sort((a,b)=>a-b);source.dataset.colorPerformance=JSON.stringify({submitP50:sorted[Math.floor(sorted.length*.5)],submitP95:sorted[Math.floor(sorted.length*.95)],submitMax:sorted.at(-1)});}
  return true;
}
export function gpuCapture(source:HTMLCanvasElement){const entry=entries.get(source);return entry&&!entry.disabled?entry.surface.captureSource(source):undefined;}
export function disposeGpuPresentation(){
  active=false;unified=false;experimentalProfile=false;
  for(const [source,entry] of [...entries].reverse()){entry.surface.dispose();entry.canvas.remove();source.classList.remove('frame-source');}
  entries.clear();
}

export function gpuFallbackGeometry(source:HTMLCanvasElement){const entry=entries.get(source);return entry?.disabled?entry.geometry:null;}
