import type { DecodedFrame } from '../contract.ts';

/** One validated origin frame, owned here until handed to a caller or invalidated. */
export function createVerifiedFrameHandoff(sourceVersion?: () => string) {
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
      if (ptsUs === 0) {
        // Admission precedes library attachment or restored local IDs. Keep the
        // actual AU witness, but bind its namespace at delivery like a new read.
        const picture = frame?.sourcePicture, version = picture && sourceVersion?.();
        if (frame && picture && version !== undefined && picture.sourceVersion !== version)
          return { ...frame, sourcePicture: { ...picture, sourceVersion: version } };
        return frame;
      }
      frame?.close();
      return undefined;
    },
  };
}
