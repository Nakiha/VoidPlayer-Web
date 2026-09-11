/** Shared by Node, browser integration checks and adversarial oracle tests. */
export type ReferenceFrame = { ptsUs: number; width: number; height: number; signature?: number[]; planeSignature?: number[] };
export type ObservedFrame = ReferenceFrame & { bytes?: number };
export type Failure = { code: string; detail: string };
/** 4x4 regional means per raw plane, independent of any YUV→RGB convention.
 * Decode is bit-exact, so plane fingerprints must match exactly. */
export function planeSignature(pixels: ArrayLike<number>, layout: { bitDepth: number; semiplanar: boolean; planes: { offset: number; stride: number; width: number; height: number }[] }): number[] {
  const bytes = layout.bitDepth > 8 ? 2 : 1;
  const result: number[] = [];
  for (let plane = 0; plane < layout.planes.length; plane++) for (let channel = 0; channel < (layout.semiplanar && plane ? 2 : 1); channel++) {
    const p = layout.planes[plane];
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
      let sum = 0, count = 0;
      for (let y = Math.floor(gy * p.height / 4); y < Math.floor((gy + 1) * p.height / 4); y++) {
        for (let x = Math.floor(gx * p.width / 4); x < Math.floor((gx + 1) * p.width / 4); x++) {
          const offset = p.offset + y * p.stride + (x * (layout.semiplanar && plane ? 2 : 1) + channel) * bytes;
          sum += pixels[offset] + (bytes === 2 ? pixels[offset + 1] * 256 : 0);
          count++;
        }
      }
      result.push(Math.round(sum / count * 100) / 100);
    }
  }
  return result;
}
export function pixelSignature(pixels: ArrayLike<number>, width: number, height: number, channels = 4): number[] {
  const result: number[] = [];
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
    const sum = [0, 0, 0]; let count = 0;
    for (let y = Math.floor(gy * height / 4); y < Math.floor((gy + 1) * height / 4); y++) {
      for (let x = Math.floor(gx * width / 4); x < Math.floor((gx + 1) * width / 4); x++) {
        const offset = (y * width + x) * channels;
        for (let c = 0; c < 3; c++) sum[c] += pixels[offset + c];
        count++;
      }
    }
    result.push(...sum.map(n => Math.round(n / count * 100) / 100));
  }
  return result;
}
export function checkFrame(actual: ObservedFrame, expected: ReferenceFrame, label: string): Failure[] {
  const failures: Failure[] = [];
  const fail = (code: string, detail: string) => failures.push({ code, detail: `${label}: ${detail}` });
  if (!Number.isSafeInteger(actual.ptsUs) || Math.abs(actual.ptsUs - expected.ptsUs) > 1) fail('pts', `${actual.ptsUs} != ${expected.ptsUs}`);
  if (actual.width !== expected.width || actual.height !== expected.height) fail('geometry', `${actual.width}x${actual.height} != ${expected.width}x${expected.height}`);
  if (actual.bytes !== undefined && actual.bytes !== actual.width * actual.height * 4) fail('bytes', `invalid RGBA length ${actual.bytes}`);
  // Raw planes are the bit-exact decode gate; RGB fingerprints below span the
  // app's documented bilinear sited-chroma conversion versus swscale's filter,
  // which measures up to 8.6 regional delta on sharp synthetic SD patterns.
  if (expected.planeSignature && !actual.planeSignature) fail('planes', 'missing raw plane fingerprint');
  if (expected.planeSignature && actual.planeSignature) {
    if (actual.planeSignature.length !== expected.planeSignature.length
      || expected.planeSignature.some((n, i) => n !== actual.planeSignature![i])) fail('planes', 'raw plane fingerprint differs');
    return failures;
  }
  // Regional averages tolerate browser YUV conversion/rounding, but catch wrong
  // images/crops. This is an SDR regression fingerprint, not HDR colorimetry.
  if (expected.signature && actual.signature && actual.width === expected.width && actual.height === expected.height) {
    const delta = expected.signature.map((n, i) => Math.abs(n - actual.signature![i]));
    if (actual.signature.length !== expected.signature.length || delta.some(n => !Number.isFinite(n)) || Math.max(...delta) > 9 || delta.reduce((a, b) => a + b, 0) / delta.length > 3) fail('pixels', `RGB fingerprint differs (max=${Math.max(...delta).toFixed(2)})`);
  } else if (expected.signature && !actual.signature) fail('pixels', 'missing RGB fingerprint');
  return failures;
}
export function expectedAt(frames: ReferenceFrame[], ptsUs: number): ReferenceFrame {
  return frames.findLast(f => f.ptsUs <= ptsUs) ?? frames[0];
}
export function checkSequence(actual: ObservedFrame[], expected: ReferenceFrame[]): Failure[] {
  return [ ...(actual.length === expected.length ? [] : [{ code: 'count', detail: `${actual.length} != ${expected.length}` }]),
    ...actual.flatMap((f, i) => expected[i] ? checkFrame(f, expected[i], `frame ${i}`) : []) ];
}
export function classify(failures: Failure[], expected: { reject?: string; known?: string[] }): 'pass' | 'expected-rejection' | 'known-failure' | 'fail' {
  if (expected.reject) return failures.length === 1 && failures[0].code === `open:${expected.reject}` ? 'expected-rejection' : 'fail';
  if (!failures.length) return 'pass';
  return expected.known?.length && failures.every(f => expected.known!.includes(f.code)) ? 'known-failure' : 'fail';
}
