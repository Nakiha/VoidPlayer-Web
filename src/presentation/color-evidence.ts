/** Diagnostics only: no conversion, sampling, or automatic pixel collection. */
export function summarizeRgba(bytes: Uint8ClampedArray) {
  if (!bytes.length || bytes.length % 4) throw new Error('Invalid RGBA buffer');
  const count = bytes.length / 4;
  const channels = [0, 1, 2].map(channel => {
    let sum = 0, min = 255, max = 0, zeros = 0, saturated = 0;
    for (let i = channel; i < bytes.length; i += 4) {
      const v = bytes[i]; sum += v; min = Math.min(min, v); max = Math.max(max, v);
      zeros += +(v === 0); saturated += +(v === 255);
    }
    return { mean: sum / count, min, max, zeros, saturated };
  });
  return { pixels: count, rgb: channels };
}

export function compareRgba(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (!a.length || a.length !== b.length || a.length % 4) throw new Error('RGBA buffers must have equal nonzero dimensions');
  let abs = 0, squared = 0, max = 0, differentPixels = 0, pixelsOver2 = 0, pixelsOver8 = 0;
  const signed = [0, 0, 0];
  for (let i = 0; i < a.length; i += 4) {
    let different = false, pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const delta = b[i + c] - a[i + c]; signed[c] += delta;
      abs += Math.abs(delta); squared += delta * delta; max = Math.max(max, Math.abs(delta)); different ||= delta !== 0;
      pixelMax = Math.max(pixelMax, Math.abs(delta));
    }
    differentPixels += +different;
    pixelsOver2 += +(pixelMax > 2); pixelsOver8 += +(pixelMax > 8);
  }
  const pixels = a.length / 4;
  return { pixels, mae: abs / (pixels * 3), rmse: Math.sqrt(squared / (pixels * 3)), max,
    differentPixels, pixelsOver2, pixelsOver8, meanSignedRgb: signed.map(sum => sum / pixels) };
}
