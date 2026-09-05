import type { DecodedFrame } from './media.ts';

// Presentation is the only place that decides HOW a decoded frame reaches the
// canvas. Backends deliver timestamps plus a resource (WebCodecs sample or
// RGBA8 pixels); they never paint. HDR/color-managed output would replace this
// module, not the decoders.
export function paintFrame(canvas: HTMLCanvasElement, frame: DecodedFrame) {
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建画布。');
  if (frame.kind === 'rgba8') {
    if (!frame.pixels) throw new Error('RGBA 帧缺少像素数据。');
    ctx.putImageData(new ImageData(frame.pixels as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height), 0, 0);
    return;
  }
  if (!frame.sample) throw new Error('视频帧缺少采样内容。');
  frame.sample.draw(ctx, 0, 0, canvas.width, canvas.height);
}
