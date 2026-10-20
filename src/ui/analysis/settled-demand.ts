/** Debounce changed demand, not the session notifications that redraw it. */
export function createSettledAnalysisDemand(run: () => void, delayMs = 250) {
  let identity: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    update(next: string | undefined) {
      if (disposed || next === identity) return;
      identity = next;
      clearTimeout(timer);
      timer = undefined;
      if (next === undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) run();
      }, delayMs);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
