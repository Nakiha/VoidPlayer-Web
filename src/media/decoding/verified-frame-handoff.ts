import type { DecodedFrame } from '../contract.ts';

/** One validated origin frame, owned here until handed to a caller or invalidated. */
export function createVerifiedFrameHandoff() {
  let pending: DecodedFrame | undefined;
  const clear = () => {
    const frame = pending;
    pending = undefined;
    frame?.close();
  };
  return {
    clear,
    offer(frame: DecodedFrame) {
      clear();
      pending = frame;
    },
    take(ptsUs: number) {
      const frame = pending;
      pending = undefined;
      if (ptsUs === 0) return frame;
      frame?.close();
      return undefined;
    },
  };
}
