import { log } from './log.ts';
import { getColorMode } from './color-mode.ts';
import { getPresentationChannel } from './presentation-channel.ts';
import { detectGpuProfile } from './webgpu-calibration.ts';
import { createExternalSurface } from './webgpu-color-surface.mjs';
import type { GpuSurface } from './webgpu-color-surface.mjs';
import type { DecodedFrame } from './media.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import { resolveYuvColor } from './yuv-color.ts';
import { validateDescription } from './frame-description.ts';
import { GpuPresentationGuard } from './gpu-presentation-guard.ts';

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
// REVIEW-02：跨异步失效守卫。完整 source 列表独立保存，不从已提交 entries 反推；
// 旧初始化/刷新迟到只清理自己那批，不碰新一代资源。
const gpuGuard=new GpuPresentationGuard<HTMLCanvasElement>();
function disposeCommittedLocked(){
  active=false;unified=false;experimentalProfile=false;
  for(const [source,entry] of [...entries].reverse()){try{entry.surface.dispose();}catch{}try{entry.canvas.remove();}catch{}try{source.classList.remove('frame-source');}catch{}}
  entries.clear();
}
async function initializeLocked(sources:HTMLCanvasElement[],token:number,geometryBySource?:Map<HTMLCanvasElement,PresentationGeometry|null>){
  if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('colorPipeline')==='legacy')return;
  const commonPlanes=typeof location!=='undefined'&&new URLSearchParams(location.search).get('colorPipeline')==='unified';
  const policy=getColorMode();
  // detectGpuProfile 本身是异步探测：旧 token 在等待期间被刷新取代后直接返回，
  // 不继续创建 surface，避免旧 profile 资源晚到。
  const requested=policy==='reference'?null:policy==='browser'?await detectGpuProfile():commonPlanes?null:requestedGpuMode();
  if(!gpuGuard.isCurrent(token))return;
  const mode=requested??'planes';
  let device:unknown;
  const pending=new Map<HTMLCanvasElement,{canvas:HTMLCanvasElement;surface:GpuSurface}>();
  const cleanupPending=()=>{for(const {canvas,surface} of pending.values()){try{surface.dispose();}catch{}try{canvas.remove();}catch{}}pending.clear();};
  try{
    for(const source of sources){
      if(!gpuGuard.isCurrent(token)){cleanupPending();return;}
      const canvas=document.createElement('canvas');canvas.className='frame-presentation';canvas.hidden=true;
      source.closest('.frame-stage')!.prepend(canvas);
      try{
        const surface=await createExternalSurface(canvas,device,mode);
        if(!gpuGuard.isCurrent(token)){try{surface.dispose();}catch{}try{canvas.remove();}catch{}cleanupPending();return;}
        device=surface.device;pending.set(source,{canvas,surface});
      }
      catch(error){try{canvas.remove();}catch{}throw error;}
    }
    if(!gpuGuard.isCurrent(token)){cleanupPending();return;}
    for(const [source,{canvas,surface}] of pending){
      const old=entries.get(source);
      if(old){try{old.surface.dispose();}catch{}try{old.canvas.remove();}catch{}}
      entries.set(source,{canvas,surface,geometry:geometryBySource?.get(source)??null,disabled:false});
    }
    pending.clear();
    active=true;
    unified=commonPlanes;
    experimentalProfile=requested!==null;
    log.info('media','WebGPU 色彩路径已启用。',{profile:mode,selection:commonPlanes?'explicit-common-planes':requested?'explicit-experiment':'resource-contract',nativeContract:'browser-managed',yuvContract:requested?'experimental-profile':'common-yuv-sdr'});
  }catch(error){
    // 只清理本批候选，不全局 dispose，避免清掉新一代已提交资源。
    cleanupPending();
    if(gpuGuard.isCurrent(token))log.info('media','WebGPU 初始化失败，保留现有呈现路径。',{reason:String(error)});
  }
}
export async function initializeGpuPresentation(sources:HTMLCanvasElement[]) {
  const token=gpuGuard.beginInitialize(sources);
  await initializeLocked(sources,token);
}
export async function refreshGpuColorMode(){
  const geometryBySource=new Map([...entries].map(([source,entry])=>[source,entry.geometry] as const));
  const {token,sources}=gpuGuard.beginRefresh();
  // 刷新只释放已提交；在途旧初始化看到 epoch 失效后会自行清理，不会被误提交。
  disposeCommittedLocked();
  const targets=sources.length?sources:[...geometryBySource.keys()];
  await initializeLocked(targets,token,geometryBySource);
  if(!gpuGuard.isCurrent(token))return;
  for(const [source,geometry] of geometryBySource)gpuGeometry(source,geometry);
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
  source.dataset.channel=frame.kind==='yuv'?getPresentationChannel():'rgb';
  source.dataset.colorContract=frame.kind==='yuv'?(experimentalProfile?'profile-yuv-sdr':'common-yuv-sdr'):'browser-managed';
  const timing=timings.get(source)??{values:[],count:0},values=timing.values;values.push(performance.now()-start);if(values.length>128)values.shift();timing.count++;timings.set(source,timing);
  if(timing.count%32===0){const sorted=[...values].sort((a,b)=>a-b);source.dataset.colorPerformance=JSON.stringify({submitP50:sorted[Math.floor(sorted.length*.5)],submitP95:sorted[Math.floor(sorted.length*.95)],submitMax:sorted.at(-1)});}
  return true;
}
export function gpuCapture(source:HTMLCanvasElement){
  const entry=entries.get(source);if(!entry||entry.disabled)return undefined;
  // The entry can be committed before the first GPU paint (async init racing
  // a paused frame): with no presented frame the 2D canvas already holds the
  // pixels, so fall back instead of throwing. Other capture errors propagate.
  try{return entry.surface.captureSource(source);}
  catch(error){if(error instanceof Error&&error.message==='No frame')return undefined;throw error;}
}
export function disposeGpuPresentation(){
  // 显式释放同样使在途初始化失效；旧任务迟到只清理自己，不再全局清理。
  gpuGuard.invalidate();
  disposeCommittedLocked();
}

export function gpuFallbackGeometry(source:HTMLCanvasElement){const entry=entries.get(source);return entry?.disabled?entry.geometry:null;}
