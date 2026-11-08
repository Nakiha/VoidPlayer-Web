import { getColorOutput } from '../../shared/color/color-output.ts';
import { log } from '../logging/log.ts';
import { getColorMode } from '../media/policy/color-mode.ts';
import { getPresentationChannel } from './presentation-channel.ts';
import { detectGpuProfile } from './webgpu-calibration.ts';
import { createExternalSurface } from './webgpu-color-surface.mjs';
import type { GpuSurface } from './webgpu-color-surface.mjs';
import type { DecodedFrame } from '../media/contract.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import { presentationColor, isHdrTransfer } from './presentation-color.ts';
import { validateDescription } from '../../shared/media/frame-description.ts';
import { GpuPresentationGuard } from './gpu-presentation-guard.ts';
import { hdrDisplayAvailable } from './display-capabilities.ts';

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
type GpuChange = 'lost' | 'restored' | 'failed';
let initializationError: Error | undefined;
const listeners = new Set<(sources: HTMLCanvasElement[], change: GpuChange) => void>();
let recoveryRemaining = 1;
let configuredKey = '';
let initializing: { key: string; token: number; promise: Promise<void> } | undefined;
function configurationKey() {
  const pipeline = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('colorPipeline');
  return JSON.stringify([getColorMode(), getColorOutput(), pipeline, hdrDisplayAvailable()]);
}
export function observeGpuRecovery(listener: (sources: HTMLCanvasElement[], change: GpuChange) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifyRecovery(sources: HTMLCanvasElement[], change: GpuChange) {
  for (const listener of listeners) {
    try { listener(sources, change); } catch (error) { log.warn('media', '图形恢复观察失败。', { reason: String(error) }); }
  }
}
async function deviceLost(token: number, device: unknown, info: { reason: string; message: string }) {
  if (!gpuGuard.isCurrent(token)) return;
  const sources = [...entries].filter(([, entry]) => entry.surface.device === device).map(([source]) => source);
  if (!sources.length) return;
  active = false;
  for (const source of sources) {
    const entry = entries.get(source)!;
    entry.disabled = true; entry.canvas.hidden = true;
    source.dataset.colorOutputReason = 'webgpu-device-lost';
    try { entry.surface.clear(); } catch { /* Lost devices may reject cleanup submissions. */ }
  }
  log.warn('media', 'WebGPU 设备丢失，暂停呈现并尝试重建。', { reason: info.reason, message: info.message, retry: recoveryRemaining > 0 });
  notifyRecovery(sources, 'lost');
  if (!gpuGuard.isCurrent(token)) return;
  if (recoveryRemaining-- <= 0) { notifyRecovery(sources, 'failed'); return; }
  let refreshed: number;
  const rebuilding = refreshLocked(), recoveryEpoch = gpuGuard.current;
  try { refreshed = await rebuilding; }
  catch (error) {
    if (gpuGuard.isCurrent(recoveryEpoch)) notifyRecovery(sources, 'failed');
    log.warn('media', 'WebGPU 重建失败。', {reason: String(error)});
    return;
  }
  if (!gpuGuard.isCurrent(refreshed)) return;
  const recovered = sources.filter(source => entries.get(source)?.surface.available);
  if (recovered.length) notifyRecovery(recovered, 'restored');
  else notifyRecovery(sources, 'failed');
}
function disposeCommittedLocked(){
  active=false;unified=false;experimentalProfile=false;configuredKey='';
  for(const [source,entry] of [...entries].reverse()){try{entry.surface.dispose();}catch{}try{entry.canvas.remove();}catch{}try{source.classList.add('frame-source');}catch{}}
  entries.clear();
}
async function initializeLocked(sources:HTMLCanvasElement[],token:number,key:string,geometryBySource?:Map<HTMLCanvasElement,PresentationGeometry|null>){
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('colorPipeline') === 'legacy') {
    throw new Error('已移除 legacy 视频呈现，请移除 colorPipeline=legacy 参数。');
  }
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
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', source.getAttribute('aria-label') ?? '当前视频画面');
      source.classList.add('frame-source');
      source.closest('.frame-stage')!.prepend(canvas);
      try{
        const surface=await createExternalSurface(canvas,device,mode);
        if (!surface.available) { surface.dispose(); throw new Error('WebGPU device lost during initialization'); }
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
    initializationError = undefined;
    configuredKey=key;
    unified=commonPlanes;
    experimentalProfile=requested!==null;
    for (const [source, entry] of entries) void entry.surface.failure?.then(error => {
      if (!gpuGuard.isCurrent(token) || entries.get(source) !== entry || entry.disabled) return;
      entry.disabled = true;
      entry.canvas.hidden = true;
      source.dataset.colorOutputReason = 'webgpu-resource-error';
      log.warn('media', 'WebGPU 资源错误，已停止呈现。', {canvas: source.id, reason: String(error)});
      notifyRecovery([source], 'failed');
    });
    const watched = new Set<unknown>();
    for (const entry of entries.values()) if (!watched.has(entry.surface.device)) {
      watched.add(entry.surface.device);
      void entry.surface.lost.then(info => deviceLost(token, entry.surface.device, info))
        .catch(error => log.warn('media', 'WebGPU 恢复失败。', { reason: String(error) }));
    }
    log.info('media','WebGPU 色彩路径已启用。',{profile:mode,selection:commonPlanes?'explicit-common-planes':requested?'explicit-experiment':'resource-contract',nativeContract:'browser-managed',yuvContract:requested?'experimental-profile':'common-yuv',requestedOutput:getColorOutput().target,actualOutputs:[...entries.values()].map(entry=>entry.surface.outputTarget)});
  }catch(error){
    // 只清理本批候选，不全局 dispose，避免清掉新一代已提交资源。
    cleanupPending();
    if (!gpuGuard.isCurrent(token)) return;
    initializationError = new Error('视频显示需要可用的 WebGPU，请使用受支持的浏览器、系统和显卡，并检查安全连接。', {cause: error});
    log.warn('media', initializationError.message, {reason: String(error)});
    throw initializationError;
  }
}
async function initializeForConfiguration(sources: HTMLCanvasElement[], token: number, geometry?: Map<HTMLCanvasElement, PresentationGeometry | null>) {
  const key = configurationKey(), promise = initializeLocked(sources, token, key, geometry);
  const pending = { key, token, promise };
  initializing = pending;
  try { await promise; }
  finally { if (initializing === pending) initializing = undefined; }
}
export async function initializeGpuPresentation(sources:HTMLCanvasElement[]) {
  recoveryRemaining = 1;
  const token=gpuGuard.beginInitialize(sources);
  await initializeForConfiguration(sources,token);
}
async function refreshLocked(){
  const geometryBySource=new Map([...entries].map(([source,entry])=>[source,entry.geometry] as const));
  const {token,sources}=gpuGuard.beginRefresh();
  // 刷新只释放已提交；在途旧初始化看到 epoch 失效后会自行清理，不会被误提交。
  disposeCommittedLocked();
  const targets=sources.length?sources:[...geometryBySource.keys()];
  await initializeForConfiguration(targets,token,geometryBySource);
  if(!gpuGuard.isCurrent(token))return token;
  for(const [source,geometry] of geometryBySource)gpuGeometry(source,geometry);
  return token;
}
export async function refreshGpuColorMode(){
  const started = performance.now(), key = configurationKey(), pending = initializing;
  recoveryRemaining = 1;
  if (pending?.key === key && gpuGuard.isCurrent(pending.token)) {
    await pending.promise;
    if (!gpuGuard.isCurrent(pending.token)) return;
  }
  const sources = gpuGuard.sources();
  if (active && configuredKey === key && entries.size === sources.length
    && sources.every(source => { const entry = entries.get(source); return entry && !entry.disabled && entry.surface.available; })) {
    log.info('media', 'WebGPU 呈现准备完成。', { action: 'reuse', durationMs: performance.now() - started, surfaces: entries.size });
    return;
  }
  const token = await refreshLocked();
  if (!gpuGuard.isCurrent(token)) return;
  log.info('media', 'WebGPU 呈现准备完成。', { action: 'rebuild', durationMs: performance.now() - started, surfaces: entries.size });
}
export function gpuGeometry(source:HTMLCanvasElement,g:PresentationGeometry|null){
  const entry=entries.get(source);if(!entry)return false;
  if (!entry.surface.available) { entry.disabled = true; entry.canvas.hidden = true; }
  entry.geometry=g;if(entry.disabled){if(!g){entry.disabled=false;entry.surface.clear();}return false;}
  entry.canvas.hidden=!g;
  source.classList.add('frame-source');
  if(!g)entry.surface.clear();
  try { entry.surface.setGeometry(g); return true; }
  catch (error) {
    entry.disabled = true; entry.canvas.hidden = true;
    log.warn('media', 'WebGPU 视口重绘失败。', { reason: String(error) });
    notifyRecovery([source], 'failed');
    return false;
  }
}
/** Reuse the uploaded planes; changing a channel never needs a new decoded frame. */
export function gpuRedrawChannel(source: HTMLCanvasElement): boolean {
  const entry = entries.get(source);
  if (!entry || entry.disabled || !entry.geometry) return false;
  try {
    if (!entry.surface.available) throw new Error('WebGPU resource unavailable');
    return entry.surface.redrawChannel();
  } catch (error) {
    entry.disabled = true;
    entry.canvas.hidden = true;
    source.classList.add('frame-source');
    source.dataset.colorOutputReason = 'webgpu-presentation-failed';
    log.warn('media', 'WebGPU 通道重绘失败。', { reason: String(error) });
    return false;
  }
}
const colorStates = new WeakMap<HTMLCanvasElement, string>();
const timings=new WeakMap<HTMLCanvasElement,{values:number[];count:number}>();
export function gpuPaint(source:HTMLCanvasElement,frame:DecodedFrame){
  const start=performance.now();
  const entry = entries.get(source);
  if (initializationError) throw initializationError;
  if (!entry || entry.disabled || !entry.surface.available) throw new Error('WebGPU 视频呈现不可用，请刷新页面或重启浏览器。');
  validateDescription(frame.description, frame.pixels?.byteLength);
  const policy = presentationColor(frame.kind, frame.description), colorState = JSON.stringify([frame.kind, policy]);
  if (colorStates.get(source) !== colorState) {
    colorStates.set(source, colorState);
    log.info('media', 'WebGPU 上屏色彩路径', {canvas: source.id, kind: frame.kind, ...policy});
    if (policy.unsupportedHdr) log.warn('media', 'RGBA8 资源未完成 HDR 色彩转换，不适合色彩评审。', {canvas: source.id});
  }
  const nativeHdr = frame.kind === 'video-sample' && isHdrTransfer(frame.description.color.transfer);
  const unverifiedNativeHdr = frame.kind === 'video-sample' && !nativeHdr && isHdrTransfer(frame.description.sourceColor?.transfer);
  const preview = nativeHdr && !entry.surface.nativeHdrAvailable || unverifiedNativeHdr;
  const reason = unverifiedNativeHdr ? 'native-hdr-resource-unverified' : nativeHdr && preview ? entry.surface.nativeHdrReason
    : frame.kind === 'rgba8' && getColorOutput().target === 'hdr' ? 'rgba8-sdr-resource' : entry.surface.outputFallbackReason;
  if (reason) source.dataset.colorOutputReason = reason; else delete source.dataset.colorOutputReason;
  const rotation=frame.rotation??frame.sample?.rotation??0;
  const d=frame.description,swap=rotation===90||rotation===270;
  const width=swap?d.height:d.width,height=swap?d.width:d.height;
  if(source.width!==width)source.width=width;if(source.height!==height)source.height=height;
  let resource: VideoFrame | undefined;
  try{
    entry.surface.setGeometry(entry.geometry,rotation);
    resource = frame.kind === 'video-sample' ? frame.sample!.toVideoFrame() : undefined;
    entry.surface.present(resource ?? frame, undefined, undefined, preview);
  }
  catch (error) {
    entry.disabled = true;
    entry.canvas.hidden = true;
    source.dataset.colorOutputReason = 'webgpu-presentation-failed';
    throw new Error('WebGPU 视频呈现失败。', {cause: error});
  }
  finally{resource?.close();}
  source.dataset.colorExecutor=frame.kind === 'yuv' ? 'webgpu-yuv' : frame.kind === 'rgba8' ? 'webgpu-rgba' : preview ? 'webgpu-browser-sdr' : nativeHdr ? 'webgpu-browser-hdr-float' : 'webgpu-external';
  source.dataset.displayTarget=entry.surface.outputTarget;
  source.dataset.captureTarget='sdr';
  source.dataset.channel=frame.kind==='yuv'?getPresentationChannel():'rgb';
  source.dataset.colorContract=frame.kind==='yuv'?(isHdrTransfer(frame.description.color.transfer)?entry.surface.outputTarget==='hdr'?'common-yuv-hdr':'common-yuv-hdr-preview':experimentalProfile?'profile-yuv-sdr':'common-yuv-sdr'):frame.kind==='rgba8'?'rgba-resource':'browser-managed';
  const timing=timings.get(source)??{values:[],count:0},values=timing.values;values.push(performance.now()-start);if(values.length>128)values.shift();timing.count++;timings.set(source,timing);
  if(timing.count%32===0){const sorted=[...values].sort((a,b)=>a-b);source.dataset.colorPerformance=JSON.stringify({submitP50:sorted[Math.floor(sorted.length*.5)],submitP95:sorted[Math.floor(sorted.length*.95)],submitMax:sorted.at(-1)});}
  return true;
}
export function gpuRendererName(source: HTMLCanvasElement) {
  const entry = entries.get(source);
  const adapter = entry?.surface.adapter;
  if (!adapter || entry.disabled || !entry.geometry || !entry.surface.available) return null;
  return adapter.description || [adapter.vendor, adapter.architecture, adapter.device].filter(Boolean).join(' ') || null;
}
export function gpuCapture(source:HTMLCanvasElement){
  const entry = entries.get(source);
  if (!entry || entry.disabled || !entry.surface.available) throw new Error('WebGPU 当前画面不可读取。');
  return entry.surface.captureSource(source);
}

/** Diagnostic viewport readback, using the same retained resource and shader. */
export function gpuCaptureViewport(source: HTMLCanvasElement) {
  const entry = entries.get(source);
  if (!entry || entry.disabled || !entry.surface.available) throw new Error('WebGPU 视频呈现不可用。');
  return entry.surface.capture(true);
}
export function gpuDrain(source: HTMLCanvasElement) {
  const entry = entries.get(source);
  if (!entry || entry.disabled || !entry.surface.available) throw new Error('WebGPU 视频呈现不可用。');
  return entry.surface.drain();
}
export function disposeGpuPresentation(){
  // 显式释放同样使在途初始化失效；旧任务迟到只清理自己，不再全局清理。
  gpuGuard.invalidate();
  disposeCommittedLocked();
}
