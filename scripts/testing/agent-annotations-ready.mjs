/** Wait only for synthetic fixture preparation; never scan, change state, or retry opening a source. */
export async function waitForAnnotationMedia(library, names, { timeoutMs = 5000, pollMs = 25,
  now = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(pollMs) || pollMs < 1)
    throw new Error('Invalid agent annotation readiness budget');
  const deadline = now() + timeoutMs, maxChecks = Math.ceil(timeoutMs / pollMs) + 1;
  let selected = [];
  for (let check = 0; check < maxChecks; check++) {
    const entries = library.browse({ recursive: true }).entries;
    selected = names.map(name => entries.find(entry => entry.name === name));
    if (selected.every(entry => entry?.state === 'ready' && /^[a-f0-9]{24}$/.test(entry.id) && /^[a-f0-9]{24}$/.test(entry.version))) return selected;
    if (selected.some(entry => entry && !['pending', 'ready'].includes(entry.state))) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await pause(Math.min(pollMs, remaining));
  }
  throw new Error(`Agent annotation fixture media not ready: ${names.map((name, i) => `${name}:${selected[i]?.state ?? 'absent'}`).join(', ')}`);
}

// Self-contained for Playwright evaluation; the optional argument also permits deterministic contract tests.
export function annotationWorkspacePlayable(state = globalThis.window?.voidPlayer?.getState()) {
  if (!state || !Array.isArray(state.tracks)) return false;
  for (const track of state.tracks) if (track.failure) throw new Error(`Agent annotation fixture track failed: ${track.failure.message}`);
  // Progressive restore publishes pendingRelink placeholders while it is still opening a source.
  if (state.busy) return false;
  if (state.tracks.some(track => track.pendingRelink)) throw new Error('Agent annotation fixture track failed: pending relink');
  return state.tracks.length === 1 && !state.busy && !!state.tracks[0].frame;
}
