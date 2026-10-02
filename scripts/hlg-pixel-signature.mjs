// Same-browser decoded-picture identity, not a colorimetry or HDR reference.
// Opaque native HLG resources follow the browser-managed Canvas 2D contract.
const columns = 32, rows = 18, maxReadbackBytes = 64 * 1024 * 1024;
const require = (value, message) => { if (!value) throw new Error(`HLG pixel readback: ${message}`); };

export function createHlgPixelSampler({ createCanvas = (width, height) => new OffscreenCanvas(width, height) } = {}) {
  let canvas, context;
  return async output => {
    const frame = output.frame, description = output.description;
    const outputFormat = frame ? frame.format : description?.format;
    let bytes, plane, width, height, x = 0, y = 0, depth = 8, shift = 0, channels = 1, sampleBytes = 1;
    let readbackPath, sampleFormat = outputFormat;
    if (frame?.format === null) {
      ({ width, height } = frame.visibleRect);
      require(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 && width * height * 4 <= maxReadbackBytes, 'invalid opaque-frame dimensions');
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = createCanvas(width, height);
        context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      }
      require(context, 'opaque VideoFrame.format=null requires Canvas 2D readback');
      // Clear first so a no-op draw cannot reuse the preceding frame's pixels.
      context.clearRect(0, 0, width, height);
      context.drawImage(frame, 0, 0, width, height);
      bytes = context.getImageData(0, 0, width, height).data;
      plane = { offset: 0, stride: width * 4 }; channels = 3; sampleBytes = 4;
      readbackPath = 'browser-managed-canvas2d-srgb'; sampleFormat = 'RGBA';
    } else if (frame) {
      const planar = /^I(?:420|422|444)(?:P(10|12))?$/.exec(frame.format);
      if (planar) { depth = Number(planar[1] ?? 8); sampleBytes = depth > 8 ? 2 : 1; }
      else if (frame.format === 'P010') { depth = 10; shift = 6; sampleBytes = 2; }
      else if (['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(frame.format)) { channels = 3; sampleBytes = 4; }
      else require(frame.format === 'NV12', `unsupported native format ${String(frame.format)}`);
      const size = frame.allocationSize();
      require(Number.isSafeInteger(size) && size > 0 && size <= maxReadbackBytes, 'invalid native allocation size');
      bytes = new Uint8Array(size);
      [plane] = await frame.copyTo(bytes);
      // copyTo defaults to visibleRect, so the returned first plane is cropped.
      ({ width, height } = frame.visibleRect);
      readbackPath = channels === 3 ? 'native-copy-rgb' : 'native-copy-luma';
    } else if (output.pixels && description?.yuv) {
      bytes = new Uint8Array(output.pixels);
      const yuv = description.yuv;
      [plane] = yuv.planes; depth = yuv.bitDepth; shift = yuv.bitShift;
      sampleBytes = depth > 8 ? 2 : 1;
      ({ x, y, width, height } = description.visibleRect);
      require(x + width <= plane.width && y + height <= plane.height, 'visible luma crop exceeds plane');
      readbackPath = 'wasm-luma';
    } else if (output.pixels && description?.format === 'RGBA') {
      bytes = new Uint8Array(output.pixels); channels = 3; sampleBytes = 4;
      plane = { offset: 0, stride: description.stride };
      ({ width, height } = description);
      readbackPath = 'wasm-rgba';
    } else throw new Error(`HLG pixel readback: unsupported output format ${String(outputFormat)}`);

    require([x, y, width, height, plane?.offset, plane?.stride, depth, shift].every(Number.isSafeInteger)
      && x >= 0 && y >= 0 && width > 0 && height > 0 && plane.offset >= 0 && depth >= 8 && depth <= 16 && shift >= 0 && shift + depth <= 16,
    'invalid pixel layout');
    require(bytes.byteLength <= maxReadbackBytes && plane.stride >= (x + width) * sampleBytes
      && plane.offset + (y + height - 1) * plane.stride + (x + width) * sampleBytes <= bytes.byteLength, 'pixel plane exceeds buffer');
    const values = [];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const offset = plane.offset + (y + Math.floor((row + .5) * height / rows)) * plane.stride
        + (x + Math.floor((column + .5) * width / columns)) * sampleBytes;
      if (readbackPath === 'browser-managed-canvas2d-srgb') require(bytes[offset + 3] === 255, 'opaque native frame produced transparent pixels');
      for (let c = 0; c < channels; c++) {
        const value = (bytes[offset + c] + (depth > 8 ? bytes[offset + c + 1] * 256 : 0)) >>> shift;
        require(value < 2 ** depth, 'pixel value exceeds declared bit depth');
        values.push(value / 2 ** (depth - 8));
      }
    }
    return { values, outputFormat, readbackPath, sampleFormat, width, height, depth, shift, channels };
  };
}

export function hlgSignatureDifference(actual, expected) {
  for (const key of ['outputFormat', 'readbackPath', 'sampleFormat', 'width', 'height', 'depth', 'shift', 'channels']) {
    require(actual[key] === expected[key], `signature ${key} changed: ${expected[key]} -> ${actual[key]}`);
  }
  require(actual.values.length > 0 && actual.values.length === expected.values.length, 'signature length changed');
  return actual.values.reduce((sum, value, i) => {
    require(Number.isFinite(value) && Number.isFinite(expected.values[i]), 'non-finite signature');
    return sum + Math.abs(value - expected.values[i]);
  }, 0) / actual.values.length;
}

export function hlgSignatureHasSpatialVariation({ values, channels }) {
  // Compare each channel across pixels: solid red is still a uniform image.
  for (let channel = 0; channel < channels; channel++) {
    let min = Infinity, max = -Infinity;
    for (let i = channel; i < values.length; i += channels) {
      min = Math.min(min, values[i]); max = Math.max(max, values[i]);
    }
    if (max - min > 1) return true;
  }
  return false;
}
