/** Shared by Node, browser integration checks and adversarial oracle tests. */
export type ReferenceFrame = { ptsUs: number; width: number; height: number; signature?: number[] };
export type ObservedFrame = ReferenceFrame & { bytes?: number };
export type Failure = { code: string; detail: string };
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
  if (Math.abs(actual.ptsUs - expected.ptsUs) > 1) fail('pts', `${actual.ptsUs} != ${expected.ptsUs}`);
  if (actual.width !== expected.width || actual.height !== expected.height) fail('geometry', `${actual.width}x${actual.height} != ${expected.width}x${expected.height}`);
  if (actual.bytes !== undefined && actual.bytes !== actual.width * actual.height * 4) fail('bytes', `invalid RGBA length ${actual.bytes}`);
  // Regional averages tolerate browser YUV conversion/rounding, but catch wrong
  // images/crops. This is an SDR regression fingerprint, not HDR colorimetry.
  if (expected.signature && actual.signature && actual.width === expected.width && actual.height === expected.height) {
    const delta = expected.signature.map((n, i) => Math.abs(n - actual.signature![i]));
    if (actual.signature.length !== expected.signature.length || delta.some(n => !Number.isFinite(n)) || Math.max(...delta) > 8 || delta.reduce((a, b) => a + b, 0) / delta.length > 3) fail('pixels', `RGB fingerprint differs (max=${Math.max(...delta).toFixed(2)})`);
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
