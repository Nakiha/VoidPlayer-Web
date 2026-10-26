/** Functional presentation proof. Self-contained for Playwright serialization;
 * its separate watchdog never changes a benchmark's sampling window/result. */
export function waitForPlaybackPresentation(options = {}) {
  const api = options.api ?? globalThis.window?.voidPlayer;
  const clock = {
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
    ...options.clock,
  };
  const idleMs = options.idleMs ?? 20000, totalMs = options.totalMs ?? 60000;
  const pauseGuardMs = options.pauseGuardMs ?? 100, pollMs = options.pollMs ?? 250, minAdvanceUs = options.minAdvanceUs ?? 0, minPlayingMs = options.minPlayingMs ?? 0;
  if (![idleMs, totalMs, pauseGuardMs, pollMs].every(value => Number.isSafeInteger(value) && value > 0) || totalMs < idleMs || !Number.isFinite(minAdvanceUs) || minAdvanceUs < 0 || !Number.isFinite(minPlayingMs) || minPlayingMs < 0 || minPlayingMs >= totalMs)
    throw new Error('Invalid functional presentation watchdog');
  if (!api?.subscribePresentedFrames || !api?.subscribeState) throw new Error('Actual presentation subscription unavailable');
  const getToken = slot => api.tools.find(tool => tool.name === 'get_presented_frame').execute({ slot });
  const initial = api.getState(), slots = options.slots ?? initial.tracks.map(track => track.slot);
  if (!slots.length || new Set(slots).size !== slots.length || initial.playing || initial.busy || initial.error)
    throw new Error('Functional presentation requires loaded, paused tracks');
  const sourceKey = track => JSON.stringify([track.id, track.sourceGen, track.source ?? null]);
  const baseline = new Map(slots.map(slot => {
    const track = initial.tracks.find(track => track.slot === slot), token = getToken(slot);
    if (!track || track.failure || !token || token.slot !== slot || !Number.isFinite(token.normalizedMediaUs) || !Number.isFinite(token.sourcePtsUs) || !Number.isSafeInteger(token.commit) || !Number.isSafeInteger(token.generation) || token.timeMapping !== 'source-microseconds-minus-first-pts')
      throw new Error(`No actual baseline presentation for ${slot}`);
    return [slot, { key: sourceKey(track), token }];
  }));
  return new Promise((resolve, reject) => {
    const started = clock.now(), pending = new Set(slots), advanced = new Map(), seen = new Map([...baseline].map(([slot, value]) => [slot, value.token]));
    let lastProgress = started, phase = 'waiting', terminal = false, playResolved = false;
    let unsubscribe, unsubscribeState, polling, guard, holding, pausedSignature, playingMs, playingStarted;
    const signature = state => JSON.stringify([state.positionUs, slots.map(slot => {
      const track = state.tracks.find(track => track.slot === slot);
      return [sourceKey(track), track.frame?.ptsUs, getToken(slot)];
    })]);
    const stop = error => {
      if (terminal) return;
      terminal = true;
      unsubscribe?.(); unsubscribeState?.(); clock.clearInterval(polling); clock.clearTimeout(guard); clock.clearTimeout(holding);
      options.signal?.removeEventListener('abort', abort);
      try { api.pause(); } catch (cause) { error ??= cause; }
      if (error) reject(error);
      else resolve({ slots, elapsedMs: clock.now() - started, playingMs, presentations: [...advanced.values()], pauseStable: true });
    };
    const inspect = () => {
      const state = api.getState();
      if (state.error) throw new Error(`Playback error: ${state.error}`);
      for (const slot of slots) {
        const track = state.tracks.find(track => track.slot === slot);
        if (!track || track.failure || sourceKey(track) !== baseline.get(slot).key)
          throw new Error(`Playback source changed or failed: ${slot}`);
      }
      return state;
    };
    const deadline = () => {
      if (clock.now() - started >= totalMs) throw new Error('Functional presentation total timeout');
      if (phase === 'waiting' && clock.now() - lastProgress >= idleMs) throw new Error('Functional presentation made no strict frame progress');
    };
    const abort = () => stop(options.signal.reason ?? new DOMException('Presentation cancelled', 'AbortError'));
    const received = (slot, token) => {
      if (terminal || !baseline.has(slot)) return;
      // Session emits during draw; inspect the committed track after that
      // synchronous transaction completes, rather than a decode/queue event.
      queueMicrotask(() => {
        if (terminal) return;
        try {
          deadline(); const state = inspect();
          if (phase !== 'waiting') throw new Error('Late presentation after pause');
          const before = baseline.get(slot).token, previous = seen.get(slot), current = getToken(slot);
          if (!current || JSON.stringify(current) !== JSON.stringify(token) || token.slot !== slot || token.generation !== before.generation || token.timeMapping !== before.timeMapping)
            throw new Error(`Presented frame identity mismatch: ${slot}`);
          if (before.picture && (!token.picture || ['sourceVersion', 'stream', 'layer', 'field'].some(key => token.picture[key] !== before.picture[key])))
            throw new Error(`Presented source picture mismatch: ${slot}`);
          if (typeof token.normalizedMediaUs !== 'number' || typeof token.sourcePtsUs !== 'number' || !Number.isFinite(token.normalizedMediaUs) || !Number.isFinite(token.sourcePtsUs) || !Number.isSafeInteger(token.commit))
            throw new Error('Unknown presentation timestamp or commit');
          if (Math.abs((token.sourcePtsUs - token.normalizedMediaUs) - (before.sourcePtsUs - before.normalizedMediaUs)) > 1)
            throw new Error('Presented frame time mapping mismatch');
          const track = state.tracks.find(track => track.slot === slot);
          if (track.frame?.ptsUs !== token.normalizedMediaUs) throw new Error('Committed track does not match presented frame');
          if (!state.playing || playingStarted === undefined) throw new Error('Presentation arrived without continuous playback');
          // Only a completely identical, fully validated token is a harmless
          // duplicate. A changed token cannot reuse an earlier commit/time.
          if (JSON.stringify(token) === JSON.stringify(previous)) return;
          if (token.commit <= previous.commit) throw new Error('Changed presentation reused or regressed its commit');
          if (token.normalizedMediaUs <= previous.normalizedMediaUs || token.sourcePtsUs <= previous.sourcePtsUs) throw new Error('Presented frame regressed or failed to advance');
          if (before.picture && JSON.stringify(token.picture) === JSON.stringify(previous.picture)) throw new Error('Strict successor reused picture identity');
          seen.set(slot, token);
          if (!pending.has(slot)) return;
          lastProgress = clock.now();
          if (token.normalizedMediaUs - before.normalizedMediaUs <= minAdvanceUs) return;
          pending.delete(slot); advanced.set(slot, { slot, baseline: before, successor: token });
          if (!pending.size) {
            const pause = () => {
              if (terminal) return;
              try {
                deadline(); const active = inspect();
                if (!active.playing || playingStarted === undefined) throw new Error('Playback stopped during required playing span');
                playingMs = clock.now() - playingStarted;
                phase = 'pausing'; api.pause(); phase = 'paused';
                const paused = inspect(); if (paused.playing) throw new Error('Playback did not pause');
                pausedSignature = signature(paused);
                guard = clock.setTimeout(() => {
                  try { deadline(); const after = inspect();
                    if (after.playing || signature(after) !== pausedSignature) throw new Error('Frame or position changed after pause');
                    stop();
                  } catch (error) { stop(error); }
                }, pauseGuardMs);
              } catch (error) { stop(error); }
            };
            const remaining = minPlayingMs - (clock.now() - playingStarted);
            if (remaining > 0) holding = clock.setTimeout(pause, remaining); else pause();
          }
        } catch (error) { stop(error); }
      });
    };
    try {
      unsubscribe = api.subscribePresentedFrames(received);
      unsubscribeState = api.subscribeState(() => {
        if (terminal) return;
        try {
          const state = inspect();
          if (phase === 'waiting') {
            if (state.playing) playingStarted ??= clock.now();
            else if (playingStarted !== undefined) throw new Error('Playback interrupted during functional verification');
          } else if (phase === 'paused' && state.playing) throw new Error('Playback restarted after pause');
        } catch (error) { stop(error); }
      });
      polling = clock.setInterval(() => {
        try { deadline(); const state = inspect();
          if (phase === 'waiting' && playResolved && !state.playing) throw new Error('Playback stopped without a strict successor');
        } catch (error) { stop(error); }
      }, pollMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => { if (!terminal) return api.play(); }).then(() => {
        playResolved = true; if (terminal) api.pause();
      }, stop);
    } catch (error) { stop(error); }
  });
}

/** Only hardware/short-window performance outcomes are report-only. Unknown
 * and correctness failures remain required; absent window draws have the
 * independent strict-presentation proof above as their replacement. */
export function assertBenchmarkCorrectness(report) {
  if (report.error !== null || report.staleAfterPause !== false || !Array.isArray(report.failures)) throw new Error('Benchmark playback error or pause instability');
  const timing = new Set(['insufficient-sample', 'below-realtime', 'frame-lag', 'track-skew', 'pause-latency', 'no-frames']);
  const failures = report.failures.filter(value => !timing.has(value) && !/^[A-H]:(?:presentation-stall|no-frames)$/.test(value));
  if (failures.length) throw new Error(`Benchmark correctness failed: ${failures.join(', ')}`);
}

/** Reject the host wait even if the page event loop is blocked. The caller
 * still owns browser/process cleanup in its surrounding finally block. */
export async function verifyPlaybackPresentation(page, options = {}, context = {}) {
  const { withinBrowserPhase } = await import('../browser-failure-evidence.mjs');
  return withinBrowserPhase(() => page.evaluate(waitForPlaybackPresentation, options),
    (options.totalMs ?? 60000) + 5000, { ...context, phase: 'functional-presentation' });
}

/** Observe a playing, independent page without issuing play/pause/seek.
 * A one-shot snapshot can precede its next committed picture while another page
 * is active. Clock movement alone never satisfies this assertion. Timer samples establish
 * playback at observation times, not absence of short pause/resume transitions. */
export function waitForPlayingFrameAdvance(options) {
  const api=options.api??globalThis.window?.voidPlayer,baseline=options.baseline;
  const {setInterval:interval=setInterval,clearInterval:clear=clearInterval,setTimeout:timeout=setTimeout,clearTimeout:cancel=clearTimeout}=options.clock??{};
  const timeoutMs=options.timeoutMs??30000,pollMs=options.pollMs??50;
  if(!baseline?.playing||baseline.busy||baseline.error||baseline.tracks?.length!==1||!baseline.tracks[0].frame
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(pollMs)||pollMs<1)throw Error('Invalid playing-frame baseline or budget');
  return new Promise((resolve,reject)=>{
    let timer,watchdog,done=false,last;
    const stop=(error,value)=>{if(done)return;done=true;clear(timer);cancel(watchdog);if(error)reject(error);else resolve(value);};
    const inspect=()=>{try{
      const state=last=api.getState(),before=baseline.tracks[0],track=state.tracks?.[0];
      if(!state.playing||state.busy||state.error||state.tracks.length!==1||!track||track.failure||!track.frame
        ||track.id!==before.id||track.slot!==before.slot||track.sourceGen!==before.sourceGen||JSON.stringify(track.source)!==JSON.stringify(before.source))throw Error('Independent playback interrupted or source changed');
      if(state.positionUs<baseline.positionUs||track.frame?.ptsUs<before.frame.ptsUs)throw Error('Independent playback regressed');
      if(state.positionUs>baseline.positionUs&&track.frame?.ptsUs>before.frame.ptsUs)stop(null,state);
    }catch(error){stop(error);}};
    timer=interval(inspect,pollMs);watchdog=timeout(()=>stop(Error(`Independent playback made no committed frame advance: ${JSON.stringify(last)}`)),timeoutMs);inspect();
  });
}
