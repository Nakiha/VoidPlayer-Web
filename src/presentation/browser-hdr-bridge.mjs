// Browser-owned HDR conversion. The default 2D draw operation tone-maps to
// SDR even with a float16 backing store; headroom must explicitly be unlimited.
// No source-dependent transfer/gamut correction is applied by the application.
export function createBrowserHdrBridge() {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { colorSpace: 'display-p3', colorType: 'float16' });
  const attributes = context?.getContextAttributes();
  if (attributes?.colorSpace !== 'display-p3' || attributes.colorType !== 'float16')
    return { available: false, reason: 'browser-hdr-float16-unavailable' };
  if (!('globalHDRHeadroom' in context))
    return { available: false, reason: 'browser-hdr-headroom-unavailable' };
  context.globalHDRHeadroom = Infinity;
  if (context.globalHDRHeadroom !== Infinity)
    return { available: false, reason: 'browser-hdr-headroom-unavailable' };
  return {
    available: true, reason: null,
    draw(frame) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      if (context.isContextLost()) throw new Error('Browser HDR conversion context lost');
      // Resizing resets drawing state, including HDR headroom.
      context.globalHDRHeadroom = Infinity;
      context.globalCompositeOperation = 'copy';
      context.drawImage(frame, 0, 0);
      return canvas;
    },
    dispose() { canvas.width = canvas.height = 1; }
  };
}
