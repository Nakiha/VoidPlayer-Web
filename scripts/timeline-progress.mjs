// This function is also passed directly to page.evaluate, so keep it self-contained.
// Test hooks allow a deterministic slow/stalled renderer without a browser fixture.
export function observeTimelineProgress({ max, afterEndUs, timeoutMs = 30000, stallMs = 5000 }, hooks) {
  const read = hooks?.read ?? (() => {
    const state = window.voidPlayer.getState(), input = document.querySelector('#timeline');
    return { position: state.positionUs, value: Number(input.value), ratio: Number(input.parentElement.style.getPropertyValue('--progress-ratio')),
      short: state.tracks.find(track => track.slot === 'B')?.frame?.ptsUs,
      long: state.tracks.find(track => track.slot === 'A')?.frame?.ptsUs, playing: state.playing };
  });
  const now = hooks?.now ?? (() => performance.now());
  const request = hooks?.request ?? (callback => requestAnimationFrame(callback));
  const cancel = hooks?.cancel ?? (id => cancelAnimationFrame(id));
  const later = hooks?.later ?? ((callback, ms) => setTimeout(callback, ms));
  const clear = hooks?.clear ?? (id => clearTimeout(id));
  return new Promise((resolve, reject) => {
    const samples = [], started = now(), longAfterEnd = new Set(), positionsAfterEnd = new Set();
    let lastProgressAt = started, lastClockProgressAt = started, lastPosition, lastLong, frame, timer, done = false;
    const finish = error => {
      if (done) return;
      done = true; cancel(frame); clear(timer);
      const report = { samples, elapsedMs: now() - started, sampleCount: samples.length,
        distinctPositions: new Set(samples.map(sample => sample.position)).size };
      if (error) reject(new Error(`${error}; timeline evidence: ${JSON.stringify(report)}`));
      else resolve(report);
    };
    timer = later(() => finish(`timeline did not cross short-track EOF with continuing long-track frames within ${timeoutMs} ms`), timeoutMs);
    function sample() {
      if (done) return;
      try {
        const current = { ...read(), elapsedMs: now() - started };
        samples.push(current);
        if (!current.playing) return finish('playback stopped before the EOF observation completed');
        if (!Number.isFinite(current.long) || !Number.isFinite(current.short)) return finish('missing decoded track frame');
        if (current.value !== current.position || !Number.isFinite(current.ratio) || Math.abs(current.ratio - current.position / max) >= .000001)
          return finish('focused timeline does not follow the actual presentation PTS');
        if (lastPosition !== undefined && current.position < lastPosition) return finish('session clock moved backward during forward playback');
        if (lastPosition === undefined || current.position > lastPosition) { lastClockProgressAt = now(); lastPosition = current.position; }
        else if (now() - lastClockProgressAt >= stallMs) return finish(`session clock and focused timeline did not advance for ${stallMs} ms`);
        if (lastLong === undefined || current.long > lastLong) { lastProgressAt = now(); lastLong = current.long; }
        else if (now() - lastProgressAt >= stallMs) return finish(`long-track decoded frame did not advance for ${stallMs} ms`);
        if (current.position > afterEndUs) { longAfterEnd.add(current.long); positionsAfterEnd.add(current.position); }
        // Count distinct decoded frames, not redundant rAF samples or wall-clock
        // throughput. UI alignment above is still checked on EVERY observation.
        if (longAfterEnd.size >= 3 && positionsAfterEnd.size >= 3) return finish();
        frame = request(sample);
      } catch (error) { finish(error.message); }
    }
    frame = request(sample);
  });
}
