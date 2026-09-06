type FrameScheduler = {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
};

/** Coalesce layout writes outside ResizeObserver delivery, and cancel on teardown. */
export function createFrameTask(update: () => void, frames: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
}) {
  let pending: number | null = null;
  let disposed = false;
  return {
    schedule() {
      if (disposed || pending !== null) return;
      pending = frames.request(() => {
        pending = null;
        if (!disposed) update();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) frames.cancel(pending);
      pending = null;
    },
  };
}
