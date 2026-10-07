// A virtual software-rendering runner cannot certify physical GPU throughput.
// Keep the negative benchmark verdict; only its two timing failures may be
// informational. Missing samples/frames, lag, errors and pause safety still gate.
export function blockingFlvBenchmarkFailures(benchmark, { virtualRunner, engine, renderer }) {
  const virtualOnly = virtualRunner && engine === 'chromium'
    && ['webgl-yuv', 'browser-managed'].includes(renderer)
    && benchmark.environment?.hardwareUseVerified === false
    && /X11; Linux/.test(benchmark.environment?.userAgent ?? '')
    && /HeadlessChrome/.test(benchmark.environment?.userAgent ?? '')
    && benchmark.tracks.length > 0 && benchmark.tracks.every(track => ['ffmpeg-wasm', 'webcodecs'].includes(track.decoder));
  return benchmark.failures.filter(failure => !virtualOnly || !['below-realtime', 'A:presentation-stall'].includes(failure));
}
