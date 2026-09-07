import { createPresentationSurface } from './presentation-surface.ts';
import type { PresentationGeometry } from './presentation-surface.ts';
import type { DecodedFrame } from './media.ts';

// Presentation is the only place that decides HOW a decoded frame reaches the
// canvas. Backends deliver timestamps plus a resource (WebCodecs sample or
// RGBA8 pixels); they never paint. HDR/color-managed output would replace this
// module, not the decoders.
export function paintFrame(canvas: HTMLCanvasElement, frame: DecodedFrame) {
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  const surface = surfaces.get(canvas);
  if (surface?.directUpload) {
    if (frame.kind === 'rgba8') {
      if (!frame.pixels) throw new Error('RGBA 帧缺少像素数据。');
      surface.upload(frame.pixels);
      return;
    }
    if (!frame.sample) throw new Error('视频帧缺少采样内容。');
    if (frame.sample.rotation === 0) {
      const resource = frame.sample.toVideoFrame();
      try { surface.upload(resource); } finally { resource.close(); }
      return;
    }
  }
  // Rotated samples and browsers without WebGL retain the 2D compatibility path.
  const ctx = canvas.getContext('2d');
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
