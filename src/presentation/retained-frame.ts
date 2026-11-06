import type { DecodedFrame } from '../media/contract.ts';
import type { SessionResources } from '../session/resources.ts';

/** One independently owned frame per displayed canvas; never reads GPU pixels. */
export function retainPresentationFrame(frame: DecodedFrame, resources?: SessionResources): DecodedFrame {
  const bytes = frame.pixels?.byteLength ?? frame.byteSize ?? frame.width * frame.height * 4;
  const release = resources?.reserve('frames', bytes, true);
  let sample: DecodedFrame['sample'], closed = false;
  let shared: DecodedFrame | undefined;
  try {
    if (frame.pixels && frame.retain) {
      shared = frame.retain();
      return {...shared, description: structuredClone(frame.description),
        rotation: frame.rotation ?? frame.sample?.rotation ?? 0,
        close() {
          if (closed) return;
          closed = true;
          try { shared!.close(); } finally { release?.(); }
        },
      };
    }
    sample = frame.kind === 'video-sample' ? frame.sample?.clone() : undefined;
    return {
      ...frame, description: structuredClone(frame.description), sample, pixels: frame.pixels?.slice(), byteSize: bytes,
      rotation: frame.rotation ?? frame.sample?.rotation ?? 0,
      close() {
        if (closed) return;
        closed = true;
        try { sample?.close(); } finally { release?.(); }
      },
    };
  } catch (error) {
    shared?.close(); sample?.close(); release?.(); throw error;
  }
}
