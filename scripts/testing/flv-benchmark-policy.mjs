// A virtual software-rendering runner cannot certify physical GPU throughput.
// Keep the negative benchmark verdict; only its two timing failures may be
// informational. Missing samples/frames, lag, errors and pause safety still gate.
export function blockingFlvBenchmarkFailures(benchmark, { softwareRunner, engine, renderer }) {
  const softwareOnly = softwareRunner && engine === 'chromium' && renderer === 'webgl-yuv'
    && benchmark.tracks.length > 0 && benchmark.tracks.every(track => track.decoder === 'ffmpeg-wasm');
  return benchmark.failures.filter(failure => !softwareOnly || !['below-realtime', 'A:presentation-stall'].includes(failure));
}
