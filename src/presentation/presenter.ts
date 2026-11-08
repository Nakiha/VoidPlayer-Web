import type { SessionResources } from '../session/resources.ts';
import { gpuPaint, gpuCapture, gpuRendererName, gpuGeometry, gpuRedrawChannel, disposeGpuPresentation, observeGpuRecovery } from './webgpu-presenter.ts';
import { retainPresentationFrame } from './retained-frame.ts';
import { yuvPixelRgb, resolveYuvColor } from '../../shared/color/yuv-color.ts';
import { getPresentationChannel } from './presentation-channel.ts';
import { validateDescription } from '../../shared/media/frame-description.ts';
import { presentationColor } from './presentation-color.ts';
import { THUMB_MAX_EDGE } from '../../shared/thumbnails/contract.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import type { DecodedFrame } from '../media/contract.ts';
import { log } from '../logging/log.ts';
import { getColorOutput } from '../../shared/color/color-output.ts';
import {hdrDisplayAvailable} from './display-capabilities.ts';
import { HDR_PREVIEW_POLICY } from '../../shared/color/hdr-policy.ts';

// Presentation is the only place that decides HOW a decoded frame reaches the
// canvas. Backends deliver timestamps plus a resource (WebCodecs sample or
// RGBA8 pixels); they never paint. Native HDR uses browser-owned float
// conversion when available, otherwise an sRGB intermediate; only WebGPU displays video.
let presentedCommit = 0;
const performanceSamples = new WeakMap<HTMLCanvasElement, { copy: number[]; submit: number[]; count: number }>();
export function paintFrame(canvas: HTMLCanvasElement, frame: DecodedFrame) {
  paintFrameNow(canvas, frame);
  const retained = retainPresentationFrame(frame, captureBudgets.get(canvas));
  retainedFrames.get(canvas)?.close();
  retainedFrames.set(canvas, retained);
}
function paintFrameNow(canvas: HTMLCanvasElement, frame: DecodedFrame, recovering = false) {
  const start = performance.now();
  gpuPaint(canvas, frame);
  if (!recovering) frame.presentedCommit = ++presentedCommit;
  const requestedTarget = getColorOutput().target, hdr = canvas.dataset.displayTarget === 'hdr';
  frame.presentation = {requestedTarget, actualTarget: hdr ? 'hdr' : 'sdr', captureTarget: 'sdr',
    executor: canvas.dataset.colorExecutor!, contract: canvas.dataset.colorContract!, displayHdr: hdrDisplayAvailable(),
    outputColorSpace: hdr ? 'display-p3' : 'srgb', outputFormat: hdr ? 'float16' : 'unorm8', toneMapping: hdr ? 'extended' : 'standard',
    ...(requestedTarget === 'hdr' && !hdr ? {fallbackReason: canvas.dataset.colorOutputReason ?? 'hdr-output-unavailable'} : {})};
  const state = performanceSamples.get(canvas) ?? {copy: [], submit: [], count: 0}, index = state.count++ % 256;
  state.copy[index] = frame.copyMs ?? 0;
  state.submit[index] = performance.now() - start;
  performanceSamples.set(canvas, state);
}
/** Queried only for diagnostics, without requesting another adapter. */
export function presentationRendererName(canvas: HTMLCanvasElement) { return gpuRendererName(canvas); }
/** Bounded CPU submission timings, not GPU completion or physical scanout. */
export function presentationPerformance(canvas:HTMLCanvasElement) {
  const state=performanceSamples.get(canvas);if(!state)return null;
  const summary=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};};
  return {count:state.count,window:state.copy.length,copyMs:summary(state.copy),submitMs:summary(state.submit)};
}

const captureBudgets = new WeakMap<HTMLCanvasElement, SessionResources>();
const captureLeases = new Map<HTMLCanvasElement, () => void>();
const retainedFrames = new Map<HTMLCanvasElement, DecodedFrame>();
const recoveryObservers = new WeakMap<HTMLCanvasElement, (frame: DecodedFrame) => void>();
export function bindPresentationResources(canvas: HTMLCanvasElement, resources: SessionResources, recovered?: (frame: DecodedFrame) => void) {
  captureBudgets.set(canvas, resources);
  if (recovered) recoveryObservers.set(canvas, recovered);
}
/** Reuse uploaded planes without decoding or changing frame identity. */
export function redrawPresentationChannel() {
  for (const [canvas, frame] of retainedFrames) {
    if (frame.kind !== 'yuv' || !currentGeometry.get(canvas)) continue;
    if (!gpuRedrawChannel(canvas)) throw new Error('WebGPU 通道画面不可用。');
    canvas.dataset.channel = getPresentationChannel();
  }
}
function recoverFrame(canvas: HTMLCanvasElement) {
  const frame = retainedFrames.get(canvas);
  if (!frame || !currentGeometry.get(canvas)) return;
  try {
    gpuGeometry(canvas, currentGeometry.get(canvas)!);
    paintFrameNow(canvas, frame, true);
    recoveryObservers.get(canvas)?.(frame);
    canvas.dataset.presentationRecovery = 'ready';
  } catch (error) {
    canvas.dataset.presentationRecovery = 'failed';
    log.warn('media', 'WebGPU 画面恢复失败。', {canvas: canvas.id, reason: String(error)});
    window.dispatchEvent(new CustomEvent('voidplayer:presentation-error', {detail: error}));
  }
}
observeGpuRecovery((sources, change) => {
  if (change === 'restored') for (const source of sources) recoverFrame(source);
  else {
    for (const source of sources) source.dataset.presentationRecovery = change === 'lost' ? 'recovering' : 'failed';
    window.dispatchEvent(new CustomEvent(change === 'lost' ? 'voidplayer:presentation-recovering' : 'voidplayer:presentation-error'));
  }
});
/** Materialize source-sized pixels on demand; playback never calls this. */
export function captureFrame(canvas: HTMLCanvasElement) {
  const resources = captureBudgets.get(canvas), bytes = canvas.width * canvas.height * 4;
  captureLeases.get(canvas)?.(); captureLeases.delete(canvas);
  const retained = resources?.reserve('readback', bytes, true);
  if (retained) captureLeases.set(canvas, retained);
  const scratch = resources?.reserve('readback', bytes, true);
  try { return gpuCapture(canvas); }
  finally { scratch?.(); }
}

/**
 * Thumbnail-only render: an independently owned first frame drawn straight to
 * a small offscreen target using the same description, rotation, display
 * aspect and color rules as presentation. Never reads or mutates a playback
 * canvas or GPU state. Returns null when the fixed SDR/sRGB recipe cannot
 * represent the resource (e.g. unmanaged HDR) so the caller stays missing.
 */
export function renderThumbnailCanvas(frame: DecodedFrame, maxEdge = THUMB_MAX_EDGE): { canvas: OffscreenCanvas | HTMLCanvasElement; width: number; height: number } | null {
  let policy: ReturnType<typeof presentationColor>;
  try {
    validateDescription(frame.description, frame.pixels?.byteLength);
    policy = presentationColor(frame.kind, frame.description);
  } catch { return null; }
  if (policy.unsupportedHdr) return null;
  const rotation = frame.rotation ?? frame.sample?.rotation ?? 0;
  const baseW = frame.description.displayWidth ?? frame.width;
  const baseH = frame.description.displayHeight ?? frame.height;
  if (!Number.isFinite(baseW) || !Number.isFinite(baseH) || baseW <= 0 || baseH <= 0) return null;
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? baseH : baseW;
  const dispH = swapped ? baseW : baseH;
  const scale = Math.min(1, maxEdge / Math.max(dispW, dispH));
  const width = Math.max(1, Math.round(dispW * scale));
  const height = Math.max(1, Math.round(dispH * scale));
  const makeCanvas = (w: number, h: number): OffscreenCanvas | HTMLCanvasElement => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const fallback = document.createElement('canvas');
    fallback.width = w; fallback.height = h;
    return fallback;
  };
  try {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) return null;
    // Downscale filtering only; thumbnails never upscale.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (frame.kind === 'video-sample') {
      if (!frame.sample) return null;
      // draw() honors rotation metadata; the target is pre-sized swapped so a
      // plain fill preserves aspect by construction.
      frame.sample.draw(ctx, 0, 0, width, height);
      return { canvas, width, height };
    }
    if (!frame.pixels) return null;
    // Sample only the small target; never expand a full-resolution RGBA image.
    const smallW = swapped ? height : width, smallH = swapped ? width : height;
    const view = new Uint8ClampedArray(smallW * smallH * 4);
    const d = frame.description;
    const plan = frame.kind === 'yuv' ? resolveYuvColor(d) : undefined;
    if(plan?.hdr)plan.hdrPolicy=HDR_PREVIEW_POLICY;
    const rgbAt = (x: number, y: number) => {
      if (frame.kind === 'yuv') return [...yuvPixelRgb(d, frame.pixels!, x, y, plan), 255];
      const offset = (y * d.width + x) * 4;
      return frame.pixels!.subarray(offset, offset + 4);
    };
    // Bilinear source sampling matches the presentation downscale rule.
    for (let y = 0; y < smallH; y++) for (let x = 0; x < smallW; x++) {
      const sx = Math.max(0, Math.min(d.width - 1, (x + .5) * d.width / smallW - .5));
      const sy = Math.max(0, Math.min(d.height - 1, (y + .5) * d.height / smallH - .5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), wx = sx - x0, wy = sy - y0;
      const x1 = Math.min(d.width - 1, x0 + 1), y1 = Math.min(d.height - 1, y0 + 1);
      const a = rgbAt(x0, y0), b = rgbAt(x1, y0), c = rgbAt(x0, y1), e = rgbAt(x1, y1);
      const i = (y * smallW + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        view[i + channel] = (a[channel] * (1 - wx) + b[channel] * wx) * (1 - wy)
          + (c[channel] * (1 - wx) + e[channel] * wx) * wy;
      }
    }
    const image = new ImageData(view, smallW, smallH);
    const scratch = makeCanvas(image.width, image.height);
    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) return null;
    scratchCtx.putImageData(image, 0, 0);
    if (!rotation) {
      ctx.drawImage(scratch, 0, 0, width, height);
    } else {
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(rotation * Math.PI / 180);
      const alongX = swapped ? height : width;
      const alongY = swapped ? width : height;
      ctx.drawImage(scratch, -alongX / 2, -alongY / 2, alongX, alongY);
      ctx.restore();
    }
    return { canvas, width, height };
  } catch { return null; }
}

const geometryObservers=new WeakMap<HTMLCanvasElement,Set<(g:PresentationGeometry|null)=>void>>();
let currentGeometry=new WeakMap<HTMLCanvasElement,PresentationGeometry|null>();
export function observePresentationGeometry(canvas:HTMLCanvasElement,listener:(g:PresentationGeometry|null)=>void){const set=geometryObservers.get(canvas)??new Set();set.add(listener);geometryObservers.set(canvas,set);listener(currentGeometry.get(canvas)??null);return()=>{set.delete(listener);if(!set.size)geometryObservers.delete(canvas);};}
export function setPresentationGeometry(canvas: HTMLCanvasElement, geometry: PresentationGeometry | null) {
  currentGeometry.set(canvas, geometry);
  for (const listener of geometryObservers.get(canvas) ?? []) { try { listener(geometry); } catch {} }
  if (!geometry) {
    captureLeases.get(canvas)?.(); captureLeases.delete(canvas);
    retainedFrames.get(canvas)?.close(); retainedFrames.delete(canvas);
    canvas.width = canvas.height = 1;
  }
  gpuGeometry(canvas, geometry);
}
export function disposePresentation() {
  currentGeometry = new WeakMap();
  for (const frame of retainedFrames.values()) frame.close();
  retainedFrames.clear();
  for (const release of captureLeases.values()) release();
  captureLeases.clear();
  disposeGpuPresentation();
}
